import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServiceSupabase } from '@/lib/supabase';

const notebookSchema = z.object({
  name: z.string().min(3),
  description: z.string().optional(),
  documentIds: z.array(z.string()).optional()
});

export async function GET() {
  try {
    const supabase = getServiceSupabase();
    const { data, error } = await supabase.from('notebooks').select('*').order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    return NextResponse.json({ data });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = notebookSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const supabase = getServiceSupabase();
    const { data: notebook, error } = await supabase
      .from('notebooks')
      .insert({
        name: parsed.data.name,
        description: parsed.data.description ?? null
      })
      .select()
      .single();

    if (error || !notebook) {
      throw new Error(error?.message ?? 'Erro ao criar notebook');
    }

    if (parsed.data.documentIds?.length) {
      const { data: documents, error: docsError } = await supabase
        .from('documents')
        .select('id')
        .in('id', parsed.data.documentIds);

      if (docsError) throw new Error(docsError.message);

      if (documents?.length) {
        await supabase.from('notebook_documents').insert(
          documents.map((doc) => ({
            notebook_id: notebook.id,
            document_id: doc.id
          }))
        );
      }
    }

    return NextResponse.json({ data: notebook });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

const deleteSchema = z.object({ id: z.string().min(1) });

export async function DELETE(request: Request) {
  try {
    const body = await request.json();
    const parsed = deleteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const supabase = getServiceSupabase();
    const notebookId = parsed.data.id;

    const { data: chats } = await supabase.from('chats').select('id').eq('notebook_id', notebookId);
    if (chats?.length) {
      await supabase
        .from('chats')
        .delete()
        .in('id', chats.map((chat) => chat.id));
    }

    await supabase.from('notebook_documents').delete().eq('notebook_id', notebookId);
    const { error } = await supabase.from('notebooks').delete().eq('id', notebookId);
    if (error) throw new Error(error.message);

    return NextResponse.json({ deleted: notebookId });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
