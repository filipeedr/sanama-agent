import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServiceSupabase } from '@/lib/supabase';

const chatSchema = z.object({
  notebookId: z.string(),
  title: z.string().optional()
});

export async function GET() {
  try {
    const supabase = getServiceSupabase();
    const { data, error } = await supabase.from('chats').select('*').order('updated_at', { ascending: false });

    if (error) throw new Error(error.message);
    return NextResponse.json({ data });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = chatSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const supabase = getServiceSupabase();
    const { data: notebook, error: notebookError } = await supabase
      .from('notebooks')
      .select('id')
      .eq('id', parsed.data.notebookId)
      .single();

    if (!notebook || notebookError) {
      return NextResponse.json({ error: 'Notebook inválido.' }, { status: 404 });
    }

    const { data, error } = await supabase
      .from('chats')
      .insert({
        notebook_id: notebook.id,
        title: parsed.data.title ?? 'Novo chat'
      })
      .select()
      .single();

    if (error || !data) {
      throw new Error(error?.message ?? 'Erro ao criar chat');
    }

    return NextResponse.json({ data });
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
    const { error } = await supabase.from('chats').delete().eq('id', parsed.data.id);
    if (error) throw new Error(error.message);

    return NextResponse.json({ deleted: parsed.data.id });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
