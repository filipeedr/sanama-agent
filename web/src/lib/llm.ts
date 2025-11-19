import { getServerEnv } from './env';
import { estimateTokenCount } from './chunking';
import type { Json } from '@/types/supabase';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatResponse {
  choices: { message: { content: string } }[];
}

interface ChatOptions {
  maxOutputTokens?: number;
  temperature?: number;
}

export async function generateSummaryFromText(title: string, text: string): Promise<string> {
  const prompt = `Você é um assistente jurídico que serve para tirar dúvidas sobre documentos contratuais, legais e seus termos aditivos.\n` +
    `Responda de forma clara e objetiva, sem perder detalhes importantes.\n` +
    `Se a pergunta não for sobre o documento, responda que não temos informações sobre o assunto.\n` +
    `Você deve fornecer embasamento na resposta consideranto todos os arquivos do notebook.\n` +
    `Título: ${title}\n\nTexto:\n${text.slice(0, 4000)}`;
  const env = getServerEnv();
  const [message] = await callChatModel(
    [
      {
        role: 'system',
        content:
          'Você é um assistente jurídico que serve para tirar dúvidas sobre documentos contratuais, legais e seus termos atividos. Responda de forma clara e objetiva, sem perder detalhes importantes. Se a pergunta não for sobre o documento, responda que não temos informações sobre o assunto. Você deve fornecer embasamento na resposta consideranto todos os arquivos do notebook. Responda sempre em Português Brasileiro.'
      },
      { role: 'user', content: prompt }
    ],
    { maxOutputTokens: env.SUMMARY_MAX_OUTPUT_TOKENS }
  );
  return message;
}

export async function generateChatTitleFromQuestion(question: string): Promise<string> {
  const [raw] = await callChatModel(
    [
      {
        role: 'system',
        content:
          'Gere títulos curtos para conversas sobre documentos jurídicos. O título deve ter no máximo 30 caracteres, ser descritivo e não conter pontos finais.'
      },
      {
        role: 'user',
        content: `Crie um título resumido (<=30 caracteres) para esta pergunta:\n${question}`
      }
    ],
    { maxOutputTokens: 40, temperature: 0.2 }
  );

  const sanitized = raw.replace(/\s+/g, ' ').trim();
  const truncated = sanitized.slice(0, 30).trim();
  if (truncated.length) {
    return truncated;
  }
  return question.slice(0, 30).trim() || 'Novo chat';
}

export async function correctOcrTextWithLLM(ocrText: string, documentTitle?: string): Promise<string> {
  const env = getServerEnv();
  if (!env.ENABLE_OCR_CORRECTION) {
    return ocrText;
  }
  if (!env.OPENAI_API_KEY) {
    console.warn('[OCR Correction] OPENAI_API_KEY não configurada, pulando correção OCR');
    return ocrText;
  }
  const normalized = ocrText?.trim();
  if (!normalized) {
    return ocrText;
  }

  const segments = segmentOcrText(normalized, env.OCR_CORRECTION_MAX_TOKENS);
  if (!segments.length) {
    return normalized;
  }

  const correctedChunks: string[] = [];
  const batchSize = Math.max(1, env.OCR_CORRECTION_BATCH_SIZE);
  for (let index = 0; index < segments.length; index += batchSize) {
    const batch = segments.slice(index, index + batchSize);
    const results = await Promise.all(
      batch.map(async (segment) => {
        try {
          return await correctOcrChunk(segment, documentTitle);
        } catch (error) {
          console.warn('[OCR Correction] Falha ao corrigir trecho; usando texto original.', error);
          return segment;
        }
      })
    );
    correctedChunks.push(...results);
  }

  return correctedChunks.join('\n\n').trim() || normalized;
}

export async function normalizeStructuredBlockWithLLM(params: {
  text: string;
  type: 'table' | 'graphic';
  documentTitle?: string;
  maxOutputTokens?: number;
}): Promise<{ summary?: string; normalizedText?: string; structuredJson?: Json | null } | null> {
  const env = getServerEnv();
  if (!env.ENABLE_STRUCTURED_BLOCK_ENRICHMENT) {
    return null;
  }
  if (!env.OPENAI_API_KEY) {
    console.warn('[Structured Block] OPENAI_API_KEY não configurada, pulando enriquecimento de bloco estruturado');
    return null;
  }
  const sanitized = params.text?.trim();
  if (!sanitized) {
    return null;
  }

  try {
    const typeLabel = params.type === 'table' ? 'tabela' : 'gráfico/quadro';
    const [raw] = await callChatModel(
      [
        {
          role: 'system',
          content:
            'Você converte blocos OCR contendo tabelas ou gráficos em representações limpas. ' +
            'Retorne APENAS JSON com os campos: summary (texto curto), normalized_text (texto corrido com valores) e structured_data (objeto com cabeçalhos/linhas ou séries). ' +
            'Limite structured_data a no máximo 20 entradas para evitar respostas gigantes.'
        },
        {
          role: 'user',
          content: [
            `Documento: ${params.documentTitle ?? 'Sem título'}`,
            `Tipo do bloco: ${typeLabel}`,
            'Bloco OCR original (mantenha os valores):',
            sanitized,
            'Reescreva o conteúdo em texto corrido corrigido e gere um JSON estruturado fiel aos dados.'
          ]
            .filter(Boolean)
            .join('\n\n')
        }
      ],
      {
        maxOutputTokens: params.maxOutputTokens ?? env.STRUCTURED_BLOCK_MAX_TOKENS,
        temperature: 0
      }
    );
    const parsed = parseStructuredBlockResponse(raw);
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : undefined;
    const normalizedText =
      typeof parsed.normalized_text === 'string' ? parsed.normalized_text.trim() : undefined;
    const structuredJson =
      parsed.structured_data && typeof parsed.structured_data === 'object'
        ? (parsed.structured_data as Json)
        : null;
    return { summary, normalizedText, structuredJson };
  } catch (error) {
    console.warn('[Structured Block] Falha ao normalizar bloco estruturado', error);
    return null;
  }
}

export async function callChatModel(messages: ChatMessage[], options?: ChatOptions): Promise<string[]> {
  const env = getServerEnv();
  if (!env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY não configurada. Configure-a para habilitar o chat.');
  }
  const response = await fetch(`${env.OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL_CHAT,
      messages,
      max_tokens: options?.maxOutputTokens ?? env.CHAT_MAX_OUTPUT_TOKENS,
      temperature: options?.temperature ?? 0.3
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Erro no LLM: ${body}`);
  }

  const data = (await response.json()) as ChatResponse;
  return data.choices.map((choice) => choice.message.content);
}

async function correctOcrChunk(text: string, documentTitle?: string) {
  const env = getServerEnv();
  const prompt =
    `Você recebeu um texto extraído de um documento via OCR. Ele pode ter erros como caracteres trocados, espaçamentos errados, linhas quebradas ou números/datas mal formatados.\n` +
    `Preserve o significado e os valores originais, mantendo parágrafos, listas e títulos.\n` +
    (documentTitle ? `Documento: ${documentTitle}\n` : '') +
    `Texto para corrigir:\n${text}\n\nRetorne SOMENTE o texto corrigido, sem comentários adicionais.`;

  const [corrected] = await callChatModel(
    [
      {
        role: 'system',
        content:
          'Você é um especialista em correção de textos extraídos via OCR. Corrija erros mantendo a formatação lógica e os dados.'
      },
      { role: 'user', content: prompt }
    ],
    {
      maxOutputTokens: Math.min(env.OCR_CORRECTION_MAX_TOKENS, Math.ceil(text.length / 3) + 200),
      temperature: 0.1
    }
  );
  return corrected.trim();
}

function segmentOcrText(text: string, maxTokens: number) {
  const normalized = text.replace(/\r\n/g, '\n');
  const pageSections = normalized.split(/\n(?=\[Page \d+\])/).filter((section) => section.trim().length > 0);
  const sections = pageSections.length ? pageSections : [normalized];
  const result: string[] = [];
  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;
    const chunks = splitSectionByTokenLimit(trimmed, maxTokens);
    result.push(...chunks);
  }
  return result;
}

function splitSectionByTokenLimit(section: string, maxTokens: number) {
  if (estimateTokenCount(section) <= maxTokens) {
    return [section];
  }
  const lines = section.split('\n');
  const header = lines[0] && /^\[Page \d+\]/i.test(lines[0].trim()) ? lines[0].trim() : null;
  const slices: string[] = [];
  let buffer: string[] = header ? [lines[0]] : [];
  let tokens = header ? estimateTokenCount(buffer[0]) : 0;

  for (let index = header ? 1 : 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineTokens = estimateTokenCount(line);
    if (tokens + lineTokens > maxTokens && buffer.length) {
      slices.push(buffer.join('\n').trim());
      buffer = header ? [`${header} (continuação)`] : [];
      tokens = header ? estimateTokenCount(buffer[0]) : 0;
    }
    buffer.push(line);
    tokens += lineTokens;
  }

  if (buffer.length) {
    slices.push(buffer.join('\n').trim());
  }
  return slices;
}

function parseStructuredBlockResponse(raw: string) {
  const attempts = [raw, stripBlockCode(raw), stripBlockPreface(raw)];
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      return JSON.parse(attempt);
    } catch {
      continue;
    }
  }
  throw new Error('Resposta do modelo não retornou JSON estruturado.');
}

function stripBlockCode(value: string) {
  const match = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (match) {
    return match[1].trim();
  }
  return value.trim();
}

function stripBlockPreface(value: string) {
  const trimmed = value.trim();
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
