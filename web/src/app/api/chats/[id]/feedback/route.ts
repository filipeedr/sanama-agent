import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServiceSupabase } from '@/lib/supabase';
import { embedTexts } from '@/lib/embeddings';
import type {
  ChatMessageRow,
  ChatRow,
  Database,
  ChatFeedbackRow
} from '@/types/supabase';

const feedbackSchema = z.object({
  messageId: z.string().min(1),
  rating: z.enum(['useful', 'incomplete', 'incorrect']),
  notes: z.string().trim().max(2000).optional(),
  revisedAnswer: z.string().trim().max(8000).optional()
});

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteParams) {
  try {
    const supabase = getServiceSupabase();
    const { id: chatId } = await context.params;
    const body = await request.json();
    const parsed = feedbackSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const { data: chat } = await supabase
      .from('chats')
      .select('id, notebook_id')
      .eq('id', chatId)
      .single<Pick<ChatRow, 'id' | 'notebook_id'>>();
    if (!chat?.notebook_id) {
      return NextResponse.json({ error: 'Chat não encontrado.' }, { status: 404 });
    }

    const { data: message, error: messageError } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('id', parsed.data.messageId)
      .single<ChatMessageRow>();

    if (messageError || !message || message.chat_id !== chatId || message.role !== 'assistant') {
      return NextResponse.json({ error: 'Mensagem inválida para feedback.' }, { status: 400 });
    }

    const { data: userMessage } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('chat_id', chatId)
      .eq('role', 'user')
      .lte('created_at', message.created_at)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<ChatMessageRow>();

    if (!userMessage?.content) {
      return NextResponse.json({ error: 'Não foi possível localizar a pergunta associada.' }, { status: 400 });
    }

    const [questionEmbedding] = await embedTexts([userMessage.content]);
    const citations = Array.isArray(message.citations)
      ? (message.citations as { chunk_id?: number | null }[])
      : [];
    const appliedChunkIds = citations
      .map((citation) => (typeof citation?.chunk_id === 'number' ? citation.chunk_id : undefined))
      .filter((value): value is number => typeof value === 'number');

    const payload = {
      chat_id: chatId,
      notebook_id: chat.notebook_id,
      message_id: message.id,
      user_message_id: userMessage.id,
      rating: parsed.data.rating,
      question: userMessage.content,
      answer: message.content,
      notes: parsed.data.notes ?? null,
      revised_answer: parsed.data.revisedAnswer ?? null,
      applied_chunk_ids: appliedChunkIds.length ? appliedChunkIds : null,
      question_embedding: questionEmbedding,
      metadata: { source: 'ui' }
    } satisfies Database['public']['Tables']['chat_feedback']['Insert'];

    const { data: inserted, error: insertError } = await supabase
      .from('chat_feedback')
      .insert([payload])
      .select()
      .single<ChatFeedbackRow>();

    if (insertError || !inserted) {
      throw new Error(insertError?.message ?? 'Falha ao salvar feedback');
    }

    return NextResponse.json({ data: inserted });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
