import { embedTexts } from './embeddings';
import { callChatModel } from './llm';
import { getServiceSupabase } from './supabase';
import { getServerEnv } from './env';
import { fetchFeedbackContext, recordChunkSignals, recordTurnTelemetry } from './feedback';
import type { FeedbackContextItem } from './feedback';
import type { Json } from '@/types/supabase';

interface Citation {
  chunk_id: number;
  document_id: string;
  similarity: number;
  label: string;
}

interface DocumentCoverage {
  totalDocuments: number;
  retrievedDocuments: string[];
  forcedDocuments: string[];
}

interface AutoReview {
  verdict: 'ok' | 'needs_review';
  summary: string;
  requiredCitations: string[];
  missingInformation: string[];
  numericAlerts: string[];
}

export interface ChatTurnResult {
  answer: string;
  citations: Citation[];
  review: AutoReview | null;
  coverage: DocumentCoverage;
  feedbackContext: FeedbackContextItem[];
}

const PROMPT_VERSION = 'rag-v2-feedback-loop';

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

  const [queryEmbedding] = await embedTexts([userMessage]);
  const { data: matches, error } = await supabase.rpc('match_chunks', {
    in_notebook_id: chat.notebook_id,
    query_embedding: queryEmbedding,
    match_count: env.RAG_MATCH_COUNT,
    similarity_threshold: 0.2
  });

  if (error) {
    throw new Error(`Erro ao buscar contexto: ${error.message}`);
  }

  const rerankedMatches = rerankMatches(matches ?? [], userMessage).slice(0, env.RAG_MATCH_COUNT);
  const hydrated = await hydrateMatches(supabase, rerankedMatches);
  const coverageResult = await ensureDocumentCoverage(supabase, documentIds, hydrated);
  const combinedMatches = [...hydrated, ...coverageResult.forcedMatches];

  const docSummariesUsed = new Set<string>();
  const contextSections = combinedMatches
    .map((match, index) => buildContextBlock(match, index, documentsMap, docSummariesUsed))
    .join('\n\n');

  const feedbackContext = await fetchFeedbackContext(chat.notebook_id, userMessage, { limit: 3 });
  const feedbackSection = buildFeedbackSection(feedbackContext);

  const [assistantResponseRaw] = await callChatModel(
    [
      {
        role: 'system',
        content:
          'Você é um especialista em contratos jurídicos com acesso a todos os documentos listados no inventário. ' +
          'Responda SEMPRE em Português Brasileiro com foco no que foi perguntado, citando apenas as partes relevantes dos documentos. ' +
          'Organize a resposta em até 4 seções numeradas ou parágrafos concisos, cite valores/datas/percentuais explicitamente ' +
          'e associe toda afirmação a uma fonte no formato [Fonte X]. Se a informação não existir, explique o que foi verificado e indique a lacuna.'
      },
      {
        role: 'user',
        content: [
          `Pergunta: ${userMessage}`,
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

  const review = await runAutoReview(userMessage, assistantResponseRaw, documentInventory, contextSections);
  const finalAnswer = appendAutoReviewNote(assistantResponseRaw, review);

  const citations: Citation[] = combinedMatches.map((match, index) => ({
    chunk_id: match.chunk_id,
    document_id: match.document_id,
    similarity: match.similarity,
    label: `Fonte ${index + 1}`
  }));

  const coverage: DocumentCoverage = {
    totalDocuments: documentIds.length,
    retrievedDocuments: Array.from(new Set(hydrated.map((match) => match.document_id))),
    forcedDocuments: coverageResult.forcedDocumentIds
  };

  await recordChunkSignals({
    notebookId: chat.notebook_id,
    chunkIds: hydrated.map((match) => match.chunk_id),
    question: userMessage,
    keywords: extractKeywords(userMessage)
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
    autoReview: review,
    feedbackContext,
    promptVersion: PROMPT_VERSION
  });

  return { answer: finalAnswer, citations, review, coverage, feedbackContext };
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

  const docSemanticLine = docSemantic?.summary ? `Insight geral do documento: ${docSemantic.summary}` : '';

  return [
    `Fonte ${index + 1} — ${label} (similaridade ${match.similarity.toFixed(2)})`,
    docSummaryLine,
    docSemanticLine,
    ...semanticLines,
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

async function runAutoReview(
  question: string,
  answer: string,
  documentInventory: string,
  contextSections: string
): Promise<AutoReview | null> {
  try {
    const [raw] = await callChatModel(
      [
        {
          role: 'system',
          content:
            'Você é um revisor crítico que avalia respostas fornecidas por outro assistente. ' +
            'Leia a pergunta, o inventário de documentos e o contexto usado, depois verifique a resposta. ' +
            'Retorne SOMENTE JSON com os campos: verdict ("ok" ou "needs_review"), summary, missing_information (array de strings), required_citations (array) e numeric_alerts (array).'
        },
        {
          role: 'user',
          content: `Pergunta original: ${question}\n\nInventário analisado:\n${documentInventory}\n\nContexto fornecido:\n${
            contextSections || 'Sem contexto'
          }\n\nResposta entregue:\n${answer}`
        }
      ],
      { maxOutputTokens: 320, temperature: 0 }
    );
    const parsed = parseJsonResponse(raw);
    const result: AutoReview = {
      verdict: parsed.verdict === 'needs_review' ? 'needs_review' : 'ok',
      summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
      missingInformation: normalizeStringArray(parsed.missing_information),
      requiredCitations: normalizeStringArray(parsed.required_citations),
      numericAlerts: normalizeStringArray(parsed.numeric_alerts)
    };
    return result;
  } catch (error) {
    console.warn('[rag] Falha ao executar revisão automática', error);
    return null;
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim());
}

function appendAutoReviewNote(answer: string, review: AutoReview | null) {
  if (!review) return answer;
  const hasContent = Boolean(
    review.summary || review.missingInformation.length || review.requiredCitations.length || review.numericAlerts.length
  );
  if (!hasContent) {
    return answer;
  }
  const details: string[] = [];
  if (review.missingInformation.length) {
    details.push(`Lacunas identificadas: ${review.missingInformation.join('; ')}`);
  }
  if (review.requiredCitations.length) {
    details.push(`Citações a confirmar: ${review.requiredCitations.join('; ')}`);
  }
  if (review.numericAlerts.length) {
    details.push(`Números para dupla verificação: ${review.numericAlerts.join('; ')}`);
  }
  const header = `Revisão automática (${review.verdict === 'ok' ? 'sem alertas críticos' : 'atenção'}) — ${
    review.summary || 'sem observações adicionais'
  }`;
  return `${answer}\n\n_${[header, ...details].filter(Boolean).join('\n')}_`;
}

function parseJsonResponse(raw: string) {
  const attempts = [raw, stripCodeFences(raw), stripPreface(raw)];
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      return JSON.parse(attempt);
    } catch {
      continue;
    }
  }
  throw new Error('Resposta do revisor não está em JSON.');
}

function stripCodeFences(payload: string) {
  const match = payload.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (match) {
    return match[1].trim();
  }
  return payload.trim();
}

function stripPreface(payload: string) {
  if (!payload) return '';
  const trimmed = payload.trim();
  const firstBrace = Math.min(
    ...['{', '['].map((symbol) => {
      const index = trimmed.indexOf(symbol);
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    })
  );
  if (firstBrace === Number.MAX_SAFE_INTEGER) {
    return trimmed;
  }
  return trimmed.slice(firstBrace);
}
