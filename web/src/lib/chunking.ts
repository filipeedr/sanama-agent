export interface Chunk {
  content: string;
  chunkIndex: number;
  tokenCount: number;
}

const MAX_TOKENS_PER_CHUNK = 320;
const MIN_TOKENS_PER_CHUNK = 120;
const HEADING_REGEX =
  /^(cl[áa]usula|anexo|cap[íi]tulo|item|art\.?|termo|título)\b|^[A-Z0-9 .\-]{6,}$/i;
const BULLET_REGEX = /^(\d+[\)\.:-]?|[-–•\*])\s+/;

type Unit = {
  content: string;
  tokens: number;
  type: 'heading' | 'bullet' | 'table' | 'text';
};

export function chunkText(text: string): Chunk[] {
  const units = buildUnits(text);
  if (!units.length) return [];

  const chunks: Chunk[] = [];
  let buffer: string[] = [];
  let bufferTokens = 0;
  let activeHeading: string | null = null;

  const flushChunk = (force = false) => {
    if (!buffer.length) return;
    const content = buffer.join('\n').trim();
    if (!content) {
      buffer = [];
      bufferTokens = 0;
      return;
    }
    chunks.push({
      content,
      chunkIndex: chunks.length,
      tokenCount: estimateTokenCount(content)
    });
    buffer = [];
    bufferTokens = 0;

    if (!force && activeHeading) {
      buffer.push(`(Continuação) ${activeHeading}`);
      bufferTokens = estimateTokenCount(buffer[0]);
    }
  };

  for (const unit of units) {
    if (unit.type === 'heading') {
      if (buffer.length) {
        flushChunk(true);
      }
      activeHeading = unit.content;
      buffer.push(unit.content);
      bufferTokens = estimateTokenCount(unit.content);
      continue;
    }

    if (unit.tokens > MAX_TOKENS_PER_CHUNK) {
      if (buffer.length) flushChunk(true);
      const slices = sliceLargeUnit(unit.content);
      for (const slice of slices) {
        buffer.push(slice);
        bufferTokens = estimateTokenCount(slice);
        flushChunk(true);
      }
      continue;
    }

    if (bufferTokens + unit.tokens > MAX_TOKENS_PER_CHUNK && bufferTokens >= MIN_TOKENS_PER_CHUNK) {
      flushChunk();
    }

    buffer.push(unit.content);
    bufferTokens += unit.tokens;
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

  return 'text';
}

function isLikelyTable(paragraph: string) {
  if (paragraph.includes('|')) return true;
  const hasLineBreaks = /\n/.test(paragraph);
  const hasManyNumbers = (paragraph.match(/\d+/g) ?? []).length >= 3;
  const hasColumns = /\s{2,}\S/.test(paragraph);
  return hasLineBreaks && (hasManyNumbers || hasColumns);
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

export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}
