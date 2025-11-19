import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServiceSupabase } from '@/lib/supabase';

const bodySchema = z.object({ documentId: z.string() });

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteParams) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const supabase = getServiceSupabase();
    const { data: notebook, error: notebookError } = await supabase.from('notebooks').select('id').eq('id', id).single();

    if (!notebook || notebookError) {
      return NextResponse.json({ error: 'Notebook não encontrado.' }, { status: 404 });
    }

    const { data: document, error: documentError } = await supabase
      .from('documents')
      .select('id')
      .eq('id', parsed.data.documentId)
      .single();

    if (!document || documentError) {
      return NextResponse.json({ error: 'Documento inválido.' }, { status: 404 });
    }

    const { error } = await supabase.from('notebook_documents').insert({
      notebook_id: notebook.id,
      document_id: document.id
    });

    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
