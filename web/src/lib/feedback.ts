import { embedTexts } from './embeddings';
import { getServiceSupabase } from './supabase';
import type { Database, Json } from '@/types/supabase';

export type FeedbackContextItem = {
  id: string;
  question: string;
  revised_answer: string | null;
  notes: string | null;
  similarity: number;
};

export async function fetchFeedbackContext(notebookId: string, userMessage: string, options?: { limit?: number }) {
  if (!notebookId) return [] as FeedbackContextItem[];
  const [queryEmbedding] = await embedTexts([userMessage]);
  const supabase = getServiceSupabase();
  const { data, error } = await supabase.rpc('match_feedback_samples', {
    in_notebook_id: notebookId,
    query_embedding: queryEmbedding,
    match_count: options?.limit ?? 3,
    similarity_threshold: 0.2
  });
  if (error || !data) {
    console.warn('[feedback] Falha ao buscar contexto de feedback', error?.message);
    return [] as FeedbackContextItem[];
  }
  return data as FeedbackContextItem[];
}

export async function recordChunkSignals(params: {
  notebookId: string;
  chunkIds: number[];
  question: string;
  keywords: string[];
}) {
  if (!params.chunkIds.length) return;
  const supabase = getServiceSupabase();
  const entries: Database['public']['Tables']['chunk_question_signals']['Insert'][] = params.chunkIds.map(
    (chunkId) => ({
      chunk_id: chunkId,
      notebook_id: params.notebookId,
      question: params.question,
      keywords: params.keywords.slice(0, 10)
    })
  );
  const { error } = await supabase.from('chunk_question_signals').insert(entries);
  if (error) {
    console.warn('[feedback] Falha ao registrar sinais por chunk', error.message);
  }
}

type RagTurnTelemetryInsert = Database['public']['Tables']['rag_turn_telemetry']['Insert'];

export async function recordTurnTelemetry(params: {
  chatId: string;
  notebookId: string;
  userMessage: string;
  answerPreview: string;
  retrievedChunks: Json | null;
  coverage: Json | null;
  autoReview: Json | null;
  feedbackContext: Json | null;
  promptVersion: string;
}) {
  const supabase = getServiceSupabase();
  const telemetryEntry: RagTurnTelemetryInsert = {
    chat_id: params.chatId,
    notebook_id: params.notebookId,
    user_message: params.userMessage,
    answer_preview: params.answerPreview,
    retrieved_chunks: params.retrievedChunks ?? null,
    coverage: params.coverage ?? null,
    auto_review: params.autoReview ?? null,
    feedback_context: params.feedbackContext ?? null,
    prompt_version: params.promptVersion
  };
  const { error } = await supabase.from('rag_turn_telemetry').insert(telemetryEntry);
  if (error) {
    console.warn('[feedback] Falha ao registrar telemetria do turno', error.message);
  }
}
