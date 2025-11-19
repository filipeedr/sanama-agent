import { embedTexts } from './embeddings';
import { callChatModel } from './llm';
import { getServiceSupabase } from './supabase';
import { getServerEnv } from './env';
import { fetchFeedbackContext, recordChunkSignals, recordTurnTelemetry } from './feedback';
import type { FeedbackContextItem } from './feedback';
import type { Json } from '@/types/supabase';

type Citation = {
  chunk_id: number;
  document_id: string;
  similarity: number;
  label: string;
};

type DocumentCoverage = {
  totalDocuments: number;
  retrievedDocuments: string[];
  forcedDocuments: string[];
};

export type ChatTurnResult = {
  answer: string;
  citations: Citation[];
  coverage: DocumentCoverage;
  feedbackContext: FeedbackContextItem[];
};

type ConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type RawChatMessageRow = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
};

const PROMPT_VERSION = 'rag-v2-feedback-loop';
const MAX_HISTORY_MESSAGES = 40;
const MAX_HISTORY_CHARACTERS = 12_000;

export async function runRagChat(chatId: string, userMessage: string): Promise<ChatTurnResult> {
  const supabase = getServiceSupabase();
  const env = getServerEnv();
  const { data: chat, error: chatError } = await supabase
    .from('chats')
    .select('*')
    .eq('id', chatId)
    .single();

  if (!chat || chatError) {
    throw new Error('Chat não encontrado.');
  }

  if (!chat.notebook_id) {
    throw new Error('Chat sem notebook vinculado.');
  }

  const rawHistory = await fetchConversationHistory(supabase, chat.id);
  const conversationHistory = limitConversationHistory(rawHistory);
  const conversationBlock = buildConversationHistoryBlock(conversationHistory);
  const contextualizedQuestion =
    conversationHistory.length > 1
      ? await rewriteQuestionWithHistory(conversationHistory, userMessage)
      : null;
  const effectiveQuestion = contextualizedQuestion || userMessage;

  const { data: notebookDocs, error: notebookDocsError } = await supabase
    .from('notebook_documents')
    .select('document_id, added_at')
    .eq('notebook_id', chat.notebook_id)
    .order('added_at', { ascending: true });
  if (notebookDocsError) {
    throw new Error(`Erro ao listar documentos do notebook: ${notebookDocsError.message}`);
  }
  const documentIds = (notebookDocs ?? []).map((entry) => entry.document_id);
  if (!documentIds.length) {
    throw new Error('Nenhum documento associado ao notebook.');
  }

  const documentsMap = await fetchDocumentsInfo(supabase, documentIds);
  const documentInventory = buildDocumentInventory(documentIds, documentsMap);

  const [queryEmbedding] = await embedTexts([effectiveQuestion]);
  const { data: matches, error } = await supabase.rpc('match_chunks', {
    in_notebook_id: chat.notebook_id,
    query_embedding: queryEmbedding,
    match_count: env.RAG_MATCH_COUNT,
    similarity_threshold: 0.2
  });

  if (error) {
    throw new Error(`Erro ao buscar contexto: ${error.message}`);
  }

  const rerankedMatches = rerankMatches(matches ?? [], effectiveQuestion).slice(0, env.RAG_MATCH_COUNT);
  const hydrated = await hydrateMatches(supabase, rerankedMatches);
  const coverageResult = await ensureDocumentCoverage(supabase, documentIds, hydrated);
  const combinedMatches = [...hydrated, ...coverageResult.forcedMatches];

  const docSummariesUsed = new Set<string>();
  const contextSections = combinedMatches
    .map((match, index) => buildContextBlock(match, index, documentsMap, docSummariesUsed))
    .join('\n\n');

  const feedbackContext = await fetchFeedbackContext(chat.notebook_id, effectiveQuestion, { limit: 3 });
  const feedbackSection = buildFeedbackSection(feedbackContext);

  const [assistantResponseRaw] = await callChatModel(
    [
      {
        role: 'system',
        content:
          'Você é um especialista em contratos jurídicos com acesso a todos os documentos listados no inventário. ' +
          'Responda SEMPRE em Português Brasileiro com foco no que foi perguntado, citando apenas as partes relevantes dos documentos. ' +
          'Organize a resposta em parágrafos concisos (sem enumerar) e cite valores/datas/percentuais explicitamente. ' +
          'Se a informação não existir, explique o que foi verificado e indique a lacuna.'
      },
      {
        role: 'user',
        content: [
          conversationBlock
            ? `Histórico da conversa (do mais antigo para o mais recente):\n${conversationBlock}`
            : null,
          `Pergunta atual do usuário: ${userMessage}`,
          contextualizedQuestion && contextualizedQuestion !== userMessage
            ? `Pergunta interpretada para consulta aos documentos: ${contextualizedQuestion}`
            : null,
          `Inventário completo de documentos para consulta obrigatória:\n${documentInventory}`,
          `Contexto consolidado (trechos + resumos dos chunks e vizinhos):\n${contextSections || 'Sem contexto disponível'}`,
          feedbackSection ? `Correções aprendidas com usuários (use como referência adicional):\n${feedbackSection}` : null
        ]
          .filter(Boolean)
          .join('\n\n')
      }
    ],
    { maxOutputTokens: env.CHAT_MAX_OUTPUT_TOKENS, temperature: 0.25 }
  );

  const finalAnswer = assistantResponseRaw;

  const citations: Citation[] = [];

  const coverage: DocumentCoverage = {
    totalDocuments: documentIds.length,
    retrievedDocuments: Array.from(new Set(hydrated.map((match) => match.document_id))),
    forcedDocuments: coverageResult.forcedDocumentIds
  };

  await recordChunkSignals({
    notebookId: chat.notebook_id,
    chunkIds: hydrated.map((match) => match.chunk_id),
    question: effectiveQuestion,
    keywords: extractKeywords(effectiveQuestion)
  });

  await recordTurnTelemetry({
    chatId: chat.id,
    notebookId: chat.notebook_id,
    userMessage,
    answerPreview: finalAnswer.slice(0, 500),
    retrievedChunks: combinedMatches.map((match, index) => ({
      label: `Fonte ${index + 1}`,
      chunk_id: match.chunk_id,
      document_id: match.document_id,
      similarity: match.similarity,
      origin: match.origin ?? 'retrieved'
    })),
    coverage,
    autoReview: null,
    feedbackContext,
    promptVersion: PROMPT_VERSION
  });

  return { answer: finalAnswer, citations, coverage, feedbackContext };
}

type MatchRow = {
  document_id: string;
  chunk_id: number;
  content: string;
  similarity: number;
};

type HydratedMatch = MatchRow & {
  chunk_index?: number;
  metadata?: Json | null;
  neighbors: { chunk_index: number; content: string }[];
  origin?: 'retrieved' | 'forced';
};

function rerankMatches(matches: MatchRow[], query: string): MatchRow[] {
  if (!matches.length) return [];
  const keywords = extractKeywords(query);
  const lowerKeywords = keywords.map((word) => word.toLowerCase());
  const queryHasNumbers = /\d/.test(query);

  return [...matches]
    .map((match) => {
      let score = match.similarity ?? 0;
      const contentLower = match.content.toLowerCase();

      if (queryHasNumbers && /\d/.test(match.content)) {
        score += 0.04;
      }

      lowerKeywords.forEach((keyword) => {
        if (keyword.length > 3 && contentLower.includes(keyword)) {
          score += 0.02;
        }
      });

      if (/cl[áa]usula|tabela|anexo|termo|item/.test(contentLower)) {
        score += 0.01;
      }

      return { value: match, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((item) => item.value);
}

function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\w\sáéíóúãõâêîôûç]/gi, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const stopwords = new Set([
    'qual',
    'que',
    'como',
    'para',
    'uma',
    'com',
    'nos',
    'dos',
    'das',
    'se',
    'do',
    'de',
    'o',
    'a',
    'os',
    'as',
    'valor',
    'quanto'
  ]);
  return words.filter((word) => word.length > 3 && !stopwords.has(word));
}

async function hydrateMatches(
  supabase: ReturnType<typeof getServiceSupabase>,
  matches: MatchRow[]
): Promise<HydratedMatch[]> {
  if (!matches.length) return [];
  const chunkIds = matches.map((match) => match.chunk_id);
  const { data: rows } = await supabase
    .from('document_chunks')
    .select('id, document_id, chunk_index, metadata')
    .in('id', chunkIds);
  const rowMap = new Map(rows?.map((row) => [row.id, row]));
  const neighborCache = new Map<string, Map<number, { chunk_index: number; content: string }>>();

  const hydrated: HydratedMatch[] = [];
  for (const match of matches) {
    const details = rowMap.get(match.chunk_id);
    const neighbors = await resolveNeighbors(
      supabase,
      neighborCache,
      match.document_id,
      details?.chunk_index
    );
    hydrated.push({
      ...match,
      chunk_index: details?.chunk_index ?? undefined,
      metadata: details?.metadata ?? null,
      neighbors,
      origin: 'retrieved'
    });
  }

  return hydrated;
}

async function resolveNeighbors(
  supabase: ReturnType<typeof getServiceSupabase>,
  cache: Map<string, Map<number, { chunk_index: number; content: string }>>,
  documentId: string,
  chunkIndex?: number | null
) {
  if (chunkIndex === undefined || chunkIndex === null) return [];
  const targetIndexes = [chunkIndex - 1, chunkIndex + 1].filter((value) => value >= 0);
  if (!targetIndexes.length) return [];
  let docCache = cache.get(documentId);
  if (!docCache) {
    docCache = new Map();
    cache.set(documentId, docCache);
  }
  const missing = targetIndexes.filter((idx) => !docCache!.has(idx));
  if (missing.length) {
    const { data } = await supabase
      .from('document_chunks')
      .select('chunk_index, content')
      .eq('document_id', documentId)
      .in('chunk_index', missing);
    data?.forEach((row) => docCache!.set(row.chunk_index, row));
  }
  return targetIndexes
    .map((idx) => cache.get(documentId)?.get(idx))
    .filter((value): value is { chunk_index: number; content: string } => Boolean(value));
}

type DocumentInfo = {
  title: string;
  summary: string | null;
  metadata: Json | null;
};

async function fetchDocumentsInfo(
  supabase: ReturnType<typeof getServiceSupabase>,
  ids: string[]
) {
  if (!ids.length) return {} as Record<string, DocumentInfo>;
  const { data, error } = await supabase
    .from('documents')
    .select('id,title,original_filename,summary,metadata')
    .in('id', ids);
  if (error || !data) {
    return {} as Record<string, DocumentInfo>;
  }

  return data.reduce<Record<string, DocumentInfo>>((acc, doc) => {
    acc[doc.id] = {
      title: doc.title ?? doc.original_filename ?? doc.id,
      summary: doc.summary ?? null,
      metadata: doc.metadata ?? null
    };
    return acc;
  }, {});
}

function buildContextBlock(
  match: HydratedMatch,
  index: number,
  documentsMap: Record<string, DocumentInfo>,
  docSummariesUsed: Set<string>
) {
  const info = documentsMap[match.document_id];
  const label = info?.title ?? match.document_id;
  const includeDocSummary = Boolean(info?.summary && !docSummariesUsed.has(match.document_id));
  const docSummaryLine = includeDocSummary ? `Resumo do documento: ${info?.summary}` : '';
  if (includeDocSummary && info?.summary) {
    docSummariesUsed.add(match.document_id);
  }

  const docSemantic = extractSemanticPayload(info?.metadata);
  const chunkSemantic = extractSemanticPayload(match.metadata);
  const structuredPayload = extractStructuredPayload(match.metadata);
  const neighborsLine =
    match.neighbors.length > 0
      ? `Trechos relacionados: ${match.neighbors
          .map((neighbor) => `[#${neighbor.chunk_index}] ${neighbor.content}`)
          .join(' ')}`
      : '';

  const semanticLines = [
    chunkSemantic?.summary ? `Resumo do trecho: ${chunkSemantic.summary}` : '',
    chunkSemantic?.amounts?.length ? `Valores: ${chunkSemantic.amounts.slice(0, 4).join(', ')}` : '',
    chunkSemantic?.dates?.length ? `Datas: ${chunkSemantic.dates.slice(0, 4).join(', ')}` : '',
    chunkSemantic?.clauses?.length ? `Cláusulas: ${chunkSemantic.clauses.slice(0, 4).join(', ')}` : '',
    chunkSemantic?.keywords?.length ? `Palavras-chave: ${chunkSemantic.keywords.slice(0, 6).join(', ')}` : ''
  ].filter(Boolean);
  const structuredLines = structuredPayload
    ? [
        structuredPayload.summary ? `Resumo tabular/gráfico: ${structuredPayload.summary}` : '',
        structuredPayload.normalized_text
          ? `Estrutura interpretada: ${structuredPayload.normalized_text}`
          : '',
        structuredPayload.data ? `Dados principais: ${formatStructuredDataPreview(structuredPayload.data)}` : ''
      ].filter(Boolean)
    : [];

  const docSemanticLine = docSemantic?.summary ? `Insight geral do documento: ${docSemantic.summary}` : '';

  return [
    `Fonte ${index + 1} — ${label} (similaridade ${match.similarity.toFixed(2)})`,
    docSummaryLine,
    docSemanticLine,
    ...semanticLines,
    ...structuredLines,
    `Trecho principal:\n${match.content}`,
    neighborsLine
  ]
    .filter(Boolean)
    .join('\n');
}

function extractSemanticPayload(metadata: Json | null | undefined) {
  if (!metadata || typeof metadata !== 'object') return null;
  const semantic = (metadata as Record<string, unknown>).semantic;
  if (!semantic || typeof semantic !== 'object') return null;
  return semantic as {
    summary?: string;
    keywords?: string[];
    amounts?: string[];
    dates?: string[];
    clauses?: string[];
  } | null;
}

function extractStructuredPayload(metadata: Json | null | undefined) {
  if (!metadata || typeof metadata !== 'object') return null;
  const structured = (metadata as Record<string, unknown>).structured;
  if (!structured || typeof structured !== 'object') return null;
  return structured as {
    type?: string;
    summary?: string | null;
    normalized_text?: string | null;
    data?: Json | null;
  } | null;
}

function formatStructuredDataPreview(data: Json | null | undefined) {
  if (!data) return '';
  try {
    const serialized = JSON.stringify(data);
    if (serialized.length <= 320) {
      return serialized;
    }
    return `${serialized.slice(0, 320)}...`;
  } catch {
    return '';
  }
}

async function ensureDocumentCoverage(
  supabase: ReturnType<typeof getServiceSupabase>,
  documentIds: string[],
  matches: HydratedMatch[]
) {
  const covered = new Set(matches.map((match) => match.document_id));
  const missing = documentIds.filter((id) => !covered.has(id));
  if (!missing.length) {
    return { forcedMatches: [] as HydratedMatch[], forcedDocumentIds: [] as string[] };
  }

  const { data, error } = await supabase
    .from('document_chunks')
    .select('id, document_id, chunk_index, content, metadata')
    .in('document_id', missing)
    .order('chunk_index', { ascending: true });

  if (error) {
    console.warn('[rag] Falha ao recuperar chunks para cobertura total', error.message);
    return { forcedMatches: [] as HydratedMatch[], forcedDocumentIds: [] as string[] };
  }

  const grouped = new Map<string, typeof data>();
  data?.forEach((row) => {
    const list = grouped.get(row.document_id) ?? [];
    list.push(row);
    grouped.set(row.document_id, list);
  });

  const forcedMatches: HydratedMatch[] = [];
  for (const docId of missing) {
    const rows = grouped.get(docId);
    if (!rows?.length) continue;
    const row = rows[0];
    forcedMatches.push({
      document_id: row.document_id,
      chunk_id: row.id,
      content: row.content,
      similarity: 0.01,
      chunk_index: row.chunk_index ?? undefined,
      metadata: row.metadata ?? null,
      neighbors: [],
      origin: 'forced'
    });
  }

  return { forcedMatches, forcedDocumentIds: forcedMatches.map((match) => match.document_id) };
}

function buildDocumentInventory(documentIds: string[], documentsMap: Record<string, DocumentInfo>) {
  if (!documentIds.length) return 'Sem documentos associados.';
  return documentIds
    .map((docId, index) => {
      const info = documentsMap[docId];
      if (!info) {
        return `${index + 1}. Documento ${docId}`;
      }
      const semantic = extractSemanticPayload(info.metadata);
      const lines = [
        `${index + 1}. ${info.title}`,
        info.summary ? `Resumo do documento: ${info.summary}` : '',
        semantic?.keywords?.length ? `Palavras-chave: ${semantic.keywords.slice(0, 6).join(', ')}` : '',
        semantic?.dates?.length ? `Datas sensíveis: ${semantic.dates.slice(0, 4).join(', ')}` : '',
        semantic?.clauses?.length ? `Cláusulas marcantes: ${semantic.clauses.slice(0, 4).join(', ')}` : ''
      ].filter(Boolean);
      return lines.join('\n');
    })
    .join('\n\n');
}

function buildFeedbackSection(feedbackItems: FeedbackContextItem[]) {
  if (!feedbackItems.length) return '';
  return feedbackItems
    .map((item, index) => {
      const payload = item.revised_answer ?? item.notes ?? '';
      return `Revisão ${index + 1} (similaridade ${(item.similarity ?? 0).toFixed(2)}): ${
        payload || 'Sem detalhes fornecidos'
      }`;
    })
    .join('\n');
}


async function fetchConversationHistory(
  supabase: ReturnType<typeof getServiceSupabase>,
  chatId: string
): Promise<ConversationMessage[]> {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('role, content')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: true });

  if (error) {
    console.warn('[rag] Falha ao buscar histórico do chat', error.message);
    return [];
  }

  const rows = (data ?? []) as RawChatMessageRow[];
  return rows
    .filter((row): row is ConversationMessage => row.role === 'user' || row.role === 'assistant')
    .map((row) => ({ role: row.role, content: row.content }));
}

function limitConversationHistory(history: ConversationMessage[]): ConversationMessage[] {
  if (!history.length) return history;
  let trimmed = history;
  if (history.length > MAX_HISTORY_MESSAGES) {
    trimmed = history.slice(-MAX_HISTORY_MESSAGES);
  }
  if (!MAX_HISTORY_CHARACTERS) {
    return trimmed;
  }

  const result: ConversationMessage[] = [];
  let consumed = 0;
  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    const entry = trimmed[index];
    consumed += entry.content.length;
    result.push(entry);
    if (consumed >= MAX_HISTORY_CHARACTERS) {
      break;
    }
  }
  return result.reverse();
}

function buildConversationHistoryBlock(history: ConversationMessage[]): string {
  if (!history.length) return '';
  return history
    .map((message) => `${message.role === 'user' ? 'Usuário' : 'Assistente'}: ${message.content}`)
    .join('\n');
}

async function rewriteQuestionWithHistory(
  history: ConversationMessage[],
  question: string
): Promise<string | null> {
  if (!history.length) return null;
  const block = buildConversationHistoryBlock(history);
  if (!block) return null;
  try {
    const [raw] = await callChatModel(
      [
        {
          role: 'system',
          content:
            'Você reescreve perguntas para que fiquem completas, sem depender de mensagens anteriores. ' +
            'Mantenha o idioma e o tom originais e não responda à pergunta.'
        },
        {
          role: 'user',
          content: [
            'Histórico completo da conversa (mais antigo primeiro):',
            block,
            `Pergunta atual do usuário: ${question}`,
            'Reescreva a pergunta acima para que seja entendida de forma independente, mantendo os detalhes necessários. ' +
              'Retorne apenas a versão reescrita.'
          ]
            .filter(Boolean)
            .join('\n\n')
        }
      ],
      { maxOutputTokens: 200, temperature: 0.2 }
    );
    const sanitized = raw.trim();
    return sanitized.length ? sanitized : null;
  } catch (error) {
    console.warn('[rag] Falha ao reescrever pergunta com histórico', error);
    return null;
  }
}
