import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServiceSupabase } from '@/lib/supabase';

const bodySchema = z.object({ documentId: z.string() });

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteParams) {
  try {
    const { id } = await context.params;
    const supabase = getServiceSupabase();
    
    const { data: notebook, error: notebookError } = await supabase.from('notebooks').select('id').eq('id', id).single();

    if (!notebook || notebookError) {
      return NextResponse.json({ error: 'Notebook não encontrado.' }, { status: 404 });
    }

    const { data: notebookDocuments, error: ndError } = await supabase
      .from('notebook_documents')
      .select('document_id')
      .eq('notebook_id', notebook.id);

    if (ndError) throw new Error(ndError.message);

    if (!notebookDocuments || notebookDocuments.length === 0) {
      return NextResponse.json({ data: [] });
    }

    const documentIds = notebookDocuments.map((nd) => nd.document_id);
    const { data: documents, error: docsError } = await supabase
      .from('documents')
      .select('*')
      .in('id', documentIds)
      .order('created_at', { ascending: false });

    if (docsError) throw new Error(docsError.message);

    return NextResponse.json({ data: documents ?? [] });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
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

export async function DELETE(request: Request, context: RouteParams) {
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

    const { error } = await supabase
      .from('notebook_documents')
      .delete()
      .eq('notebook_id', notebook.id)
      .eq('document_id', parsed.data.documentId);

    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
