import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServiceSupabase } from '@/lib/supabase';
import { uploadDocumentBinary, deleteDocumentBinaries } from '@/lib/storage';
import { processDocument } from '@/lib/pipeline';

const deleteSchema = z.object({
  ids: z.array(z.string()).min(1)
});

export async function GET() {
  try {
    const supabase = getServiceSupabase();
    const { data, error } = await supabase.from('documents').select('*').order('created_at', { ascending: false });

    if (error) {
      throw new Error(error.message);
    }

    return NextResponse.json({ data });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const rawFiles = formData.getAll('files');
    const fallback = formData.get('file');
    if (fallback instanceof File) {
      rawFiles.push(fallback);
    }
    const files = rawFiles.filter((value): value is File => value instanceof File);
    if (!files.length) {
      return NextResponse.json({ error: 'Selecione ao menos um arquivo.' }, { status: 400 });
    }

    const supabase = getServiceSupabase();
    const createdDocuments = [];

    for (const file of files) {
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const storagePath = await uploadDocumentBinary('default', file.name, buffer, file.type);

      const { data, error } = await supabase
        .from('documents')
        .insert({
          title: files.length === 1 ? formData.get('title')?.toString() ?? file.name : file.name,
          original_filename: file.name,
          storage_path: storagePath,
          mime_type: file.type,
          status: 'pending'
        })
        .select()
        .single();

      if (error || !data) {
        throw new Error(error?.message ?? 'Erro ao registrar documento.');
      }

      createdDocuments.push(data);

      await supabase.from('processing_jobs').insert({
        document_id: data.id,
        stage: 'upload',
        status: 'completed',
        payload: { size: buffer.length }
      });

      processDocument(data.id, buffer, file.type).catch((error) => {
        console.error('[pipeline] Falha ao processar documento', error);
      });
    }

    return NextResponse.json({ data: createdDocuments, processing: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json();
    const parsed = deleteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const supabase = getServiceSupabase();
    const { data: documents } = await supabase
      .from('documents')
      .select('id, storage_path')
      .in('id', parsed.data.ids);

    if (documents?.length) {
      await deleteDocumentBinaries(documents.map((doc) => doc.storage_path));
    }

    const { error } = await supabase.from('documents').delete().in('id', parsed.data.ids);
    if (error) {
      throw new Error(error.message);
    }

    return NextResponse.json({ deleted: parsed.data.ids.length });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
