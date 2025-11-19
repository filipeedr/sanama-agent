import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServiceSupabase } from '@/lib/supabase';
import { runRagChat } from '@/lib/rag';
import { generateChatTitleFromQuestion } from '@/lib/llm';

const bodySchema = z.object({ content: z.string().min(3) });

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteParams) {
  try {
    const supabase = getServiceSupabase();
    const { id } = await context.params;

    const { data: chat, error: chatError } = await supabase.from('chats').select('id').eq('id', id).single();

    if (!chat || chatError) {
      return NextResponse.json({ error: 'Chat não encontrado.' }, { status: 404 });
    }

    const { data, error } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('chat_id', chat.id)
      .order('created_at', { ascending: true });

    if (error) throw new Error(error.message);

    return NextResponse.json({ data });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function POST(request: Request, context: RouteParams) {
  try {
    const supabase = getServiceSupabase();
    const body = await request.json();
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const { id } = await context.params;
    const { data: chat, error: chatError } = await supabase.from('chats').select('*').eq('id', id).single();

    if (!chat || chatError) {
      return NextResponse.json({ error: 'Chat não encontrado.' }, { status: 404 });
    }

    const userMessage = {
      chat_id: chat.id,
      role: 'user' as const,
      content: parsed.data.content,
      metadata: { source: 'ui' }
    };

    await supabase.from('chat_messages').insert(userMessage);

    const shouldRenameChat = !chat.title || chat.title.trim().toLowerCase() === 'novo chat';
    const titlePromise = shouldRenameChat
      ? generateChatTitleFromQuestion(parsed.data.content).catch(() => null)
      : Promise.resolve<string | null>(null);

    const ragResult = await runRagChat(chat.id, parsed.data.content);
    const newTitle = await titlePromise;

    await supabase.from('chat_messages').insert({
      chat_id: chat.id,
      role: 'assistant',
      content: ragResult.answer,
      citations: ragResult.citations,
      metadata: {
        strategy: 'rag',
        feedback_context: ragResult.feedbackContext,
        prompt_version: 'rag-v2-feedback-loop'
      }
    });

    const chatUpdate: Record<string, string> = {
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    if (newTitle) {
      chatUpdate.title = newTitle;
    }

    await supabase.from('chats').update(chatUpdate).eq('id', chat.id);

    return NextResponse.json({ data: ragResult });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
