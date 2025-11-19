export type ChunkBlockType = 'heading' | 'bullet' | 'table' | 'graphic' | 'text';

export interface ChunkStructuredData {
  type: 'table' | 'graphic';
  summary?: string | null;
  normalizedText?: string | null;
  data?: Record<string, unknown> | null;
  raw?: string | null;
}

export interface Chunk {
  content: string;
  sourceText: string;
  chunkIndex: number;
  tokenCount: number;
  blockType: ChunkBlockType;
  structuredData?: ChunkStructuredData | null;
}

const MAX_TOKENS_PER_CHUNK = 320;
const MIN_TOKENS_PER_CHUNK = 120;
const HEADING_REGEX =
  /^(cl[áa]usula|anexo|cap[íi]tulo|item|art\.?|termo|título)\b|^[A-Z0-9 .\-]{6,}$/i;
const BULLET_REGEX = /^(\d+[\)\.:-]?|[-–•\*])\s+/;

type Unit = {
  content: string;
  tokens: number;
  type: 'heading' | 'bullet' | 'table' | 'graphic' | 'text';
};

export function chunkText(text: string): Chunk[] {
  const units = buildUnits(text);
  if (!units.length) return [];

  const chunks: Chunk[] = [];
  let buffer: string[] = [];
  let bufferTokens = 0;
  let bufferType: Unit['type'] | null = null;
  let activeHeading: string | null = null;

  const flushChunk = (force = false, overrideType?: Unit['type']) => {
    if (!buffer.length) return;
    const source = buffer.join('\n');
    const content = source.trim();
    if (!content) {
      buffer = [];
      bufferTokens = 0;
      bufferType = null;
      return;
    }
    chunks.push({
      content,
      sourceText: source,
      chunkIndex: chunks.length,
      tokenCount: estimateTokenCount(content),
      blockType: mapUnitTypeToBlockType(overrideType ?? bufferType ?? 'text'),
      structuredData: null
    });
    buffer = [];
    bufferTokens = 0;
    bufferType = null;

    if (!force && activeHeading) {
      const continuation = `(Continuação) ${activeHeading}`;
      buffer.push(continuation);
      bufferTokens = estimateTokenCount(continuation);
      bufferType = 'text';
    }
  };

  for (const unit of units) {
    if (unit.type === 'heading') {
      if (buffer.length) {
        flushChunk(true);
      }
      activeHeading = unit.content;
      buffer = [unit.content];
      bufferTokens = estimateTokenCount(unit.content);
      bufferType = 'heading';
      continue;
    }

    if (unit.type === 'table' || unit.type === 'graphic') {
      if (buffer.length) {
        flushChunk(true);
      }
      const slices = splitStructuredUnit(unit, MAX_TOKENS_PER_CHUNK);
      for (const slice of slices) {
        buffer = [slice];
        bufferTokens = estimateTokenCount(slice);
        bufferType = unit.type;
        flushChunk(true, unit.type);
      }
      continue;
    }

    if (unit.tokens > MAX_TOKENS_PER_CHUNK) {
      if (buffer.length) flushChunk(true);
      const slices = sliceLargeUnit(unit.content);
      for (const slice of slices) {
        buffer = [slice];
        bufferTokens = estimateTokenCount(slice);
        bufferType = unit.type;
        flushChunk(true);
      }
      continue;
    }

    if (bufferTokens + unit.tokens > MAX_TOKENS_PER_CHUNK && bufferTokens >= MIN_TOKENS_PER_CHUNK) {
      flushChunk();
    }

    buffer.push(unit.content);
    bufferTokens += unit.tokens;
    bufferType = resolveBufferType(bufferType, unit.type);
  }

  flushChunk(true);
  return chunks;
}

function buildUnits(text: string): Unit[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const paragraphs: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (!current.length) return;
    const joined = current.join(' ').trim();
    if (joined) {
      paragraphs.push(joined);
    }
    current = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }

    if (BULLET_REGEX.test(line)) {
      flush();
      paragraphs.push(line);
      continue;
    }

    current.push(line);
  }
  flush();

  return paragraphs.map((paragraph) => {
    const type = classifyParagraph(paragraph);
    return {
      content: paragraph,
      tokens: estimateTokenCount(paragraph),
      type
    };
  });
}

function classifyParagraph(paragraph: string): Unit['type'] {
  if (HEADING_REGEX.test(paragraph.trim())) {
    return 'heading';
  }

  if (BULLET_REGEX.test(paragraph.trim())) {
    return 'bullet';
  }

  if (isLikelyTable(paragraph)) {
    return 'table';
  }

  if (isLikelyGraphic(paragraph)) {
    return 'graphic';
  }

  return 'text';
}

function isLikelyTable(paragraph: string) {
  if (paragraph.includes('|')) return true;
  const hasLineBreaks = /\n/.test(paragraph);
  const hasManyNumbers = (paragraph.match(/\d+/g) ?? []).length >= 3;
  const hasColumns = /\s{2,}\S/.test(paragraph);
  return hasLineBreaks && (hasManyNumbers || hasColumns);
}

function isLikelyGraphic(paragraph: string) {
  const normalized = paragraph.toLowerCase();
  const hasGraphicKeyword = /(figura|gr[áa]fico|grafico|quadro|diagrama|imagem|ilustra[cç][aã]o)/.test(normalized);
  const hasExplicitMarker = /(fig\.|gr[áa]fico|quadro)\s*\d+/.test(paragraph);
  const hasAxes = /(eixo|percentual|tend[êe]ncia|barra|linha|coluna|escala|curva)/.test(normalized);
  return hasGraphicKeyword && (hasAxes || hasExplicitMarker);
}

function sliceLargeUnit(paragraph: string): string[] {
  const maxChars = MAX_TOKENS_PER_CHUNK * 4;
  const slices: string[] = [];
  let start = 0;
  while (start < paragraph.length) {
    let end = Math.min(paragraph.length, start + maxChars);
    if (end < paragraph.length) {
      const nextPeriod = paragraph.lastIndexOf('.', end);
      if (nextPeriod > start + 40) {
        end = nextPeriod + 1;
      }
    }
    slices.push(paragraph.slice(start, end).trim());
    start = end;
  }
  return slices;
}

function splitStructuredUnit(unit: Unit, maxTokens: number) {
  if (unit.tokens <= maxTokens) {
    return [unit.content];
  }
  const lines = unit.content.split('\n');
  const headerLine = lines[0]?.trim();
  const hasPageMarker = /^\[Page \d+\]/i.test(headerLine ?? '');
  const slices: string[] = [];
  let buffer: string[] = [];
  let tokens = 0;

  const pushSlice = () => {
    if (!buffer.length) return;
    slices.push(buffer.join('\n').trim());
    buffer = [];
    tokens = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineTokens = estimateTokenCount(line);
    if (tokens + lineTokens > maxTokens && buffer.length) {
      pushSlice();
      if (hasPageMarker && headerLine) {
        buffer.push(`${headerLine} (continuação)`);
        tokens = estimateTokenCount(buffer[0]);
      }
    }
    buffer.push(line);
    tokens += lineTokens;
  }

  pushSlice();
  return slices;
}

function mapUnitTypeToBlockType(type: Unit['type']): ChunkBlockType {
  if (type === 'table' || type === 'graphic' || type === 'heading' || type === 'bullet') {
    return type;
  }
  return 'text';
}

function resolveBufferType(current: Unit['type'] | null, incoming: Unit['type']): Unit['type'] {
  if (!current || current === 'heading') {
    return incoming === 'heading' ? 'heading' : incoming;
  }
  if (incoming === 'bullet') {
    return 'bullet';
  }
  if (incoming === 'text' && current === 'bullet') {
    return 'text';
  }
  return current;
}

export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}
