import { callChatModel } from './llm';

export type SemanticAttributes = {
  summary: string;
  keywords: string[];
  amounts: string[];
  dates: string[];
  clauses: string[];
};

const currencyRegex = /R\$\s?\d{1,3}(?:\.\d{3})*(?:,\d+)?/gi;
const dateRegex = /\b\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{2,4}\b/g;
const clauseRegex = /(cl[áa]usula\s+\d+[ºo]?|anexo\s+[ivxlcdm0-9]+)/gi;
const keywordRegex = /[A-ZÁÉÍÓÚÃÕÂÊÎÔÛÇ][A-ZÁÉÍÓÚÃÕÂÊÎÔÛÇ0-9\- ]{3,}/g;

export async function buildSemanticAttributes(
  text: string,
  context?: { title?: string | null },
  options?: { useModel?: boolean }
) {
  const sanitized = text.replace(/\s+/g, ' ').trim();
  const truncated = truncateForModel(sanitized);
  const attributes: SemanticAttributes = {
    summary: createFallbackSummary(sanitized),
    keywords: uniqueMatches(sanitized.match(keywordRegex)).slice(0, 10),
    amounts: uniqueMatches(sanitized.match(currencyRegex)).slice(0, 10),
    dates: uniqueMatches(sanitized.match(dateRegex)).slice(0, 10),
    clauses: uniqueMatches(sanitized.match(clauseRegex)).slice(0, 10)
  };

  if (options?.useModel === false) {
    return attributes;
  }

  try {
    const [raw] = await callChatModel(
      [
        {
          role: 'system',
          content:
            'Você gera resumos estruturados de cláusulas contratuais. Responda apenas em JSON. Campos: summary (string curta), key_points (array até 3 strings).'
        },
        {
          role: 'user',
          content: `Documento: ${context?.title ?? 'Sem título'}\nTrecho:\n${truncated}\nRetorne JSON`
        }
      ],
      { maxOutputTokens: 250 }
    );
    const parsed = safeParseJson(raw);
    if (typeof parsed.summary === 'string') {
      attributes.summary = parsed.summary.trim();
    }
    if (Array.isArray(parsed.key_points)) {
      const keyPoints = parsed.key_points.filter((item: unknown) => typeof item === 'string');
      attributes.keywords = uniqueArray([...attributes.keywords, ...keyPoints]);
    }
  } catch (error) {
    // se a API falhar, mantemos o fallback
    console.warn('[semantic-index] Falha ao gerar resumo semântico', error);
  }

  return attributes;
}

export function createFallbackSummary(text: string) {
  if (!text) return '';
  const trimmed = text.slice(0, 420);
  return trimmed.length < text.length ? `${trimmed}...` : trimmed;
}

function uniqueMatches(values: RegExpMatchArray | null) {
  if (!values) return [];
  return Array.from(new Set(values.map((value) => value.trim())));
}

function uniqueArray(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()))).filter(Boolean);
}

function truncateForModel(text: string, limit = 6000) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

function safeParseJson(raw: string) {
  const attempts = [raw, stripCodeFences(raw), stripPreface(raw)];
  for (const attempt of attempts) {
    if (!attempt) continue;
    try {
      return JSON.parse(attempt);
    } catch {
      // tenta próxima forma
    }
  }
  throw new Error('Resposta do modelo não retornou JSON válido');
}

function stripCodeFences(value: string) {
  const match = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (match) {
    return match[1].trim();
  }
  return value.replace(/```/g, '').trim();
}

function stripPreface(value: string) {
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
