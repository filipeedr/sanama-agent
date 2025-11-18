import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getServiceSupabase } from '@/lib/supabase';

const updateSchema = z.object({
  name: z.string().min(3).optional(),
  description: z.string().optional().nullable()
});

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, context: RouteParams) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const parsed = updateSchema.safeParse(body);
    
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const supabase = getServiceSupabase();
    const { data: notebook, error: notebookError } = await supabase.from('notebooks').select('id').eq('id', id).single();

    if (!notebook || notebookError) {
      return NextResponse.json({ error: 'Notebook não encontrado.' }, { status: 404 });
    }

    const updateData: { name?: string; description?: string | null } = {};
    if (parsed.data.name !== undefined) {
      updateData.name = parsed.data.name;
    }
    if (parsed.data.description !== undefined) {
      updateData.description = parsed.data.description;
    }

    const { data: updated, error } = await supabase
      .from('notebooks')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error || !updated) {
      throw new Error(error?.message ?? 'Erro ao atualizar notebook');
    }

    return NextResponse.json({ data: updated });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

