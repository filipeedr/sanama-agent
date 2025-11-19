import '@/lib/polyfills/domMatrix';
import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import path from 'node:path';
import type { DocumentInitParameters, PDFDocumentProxy } from 'pdfjs-dist/types/src/display/api';
import type { DocumentsRow, Json } from '@/types/supabase';

import { chunkText, estimateTokenCount, type Chunk } from './chunking';
import { embedTexts } from './embeddings';
import { getServiceSupabase } from './supabase';
import { downloadDocumentBinary } from './storage';
import { correctOcrTextWithLLM, generateSummaryFromText, normalizeStructuredBlockWithLLM } from './llm';
import { buildSemanticAttributes, type SemanticAttributes } from './semantic-index';
import { getServerEnv } from './env';

interface ExtractionResult {
  text: string;
  numPages: number;
}

type CanvasAndContext = {
  canvas: Canvas;
  context: SKRSContext2D;
};

const APP_ROOT = process.cwd();
const TESSDATA_PATH = path.join(APP_ROOT, 'tessdata');

try {
  GlobalWorkerOptions.workerSrc = path.join(APP_ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs');
} catch (error) {
  console.warn('[pipeline] Não foi possível configurar pdf.worker.mjs', error);
}

function getTesseractOptions() {
  return {
    langPath: TESSDATA_PATH,
    workerPath: path.join(APP_ROOT, 'node_modules/tesseract.js/src/worker-script/node/index.js'),
    corePath: path.join(APP_ROOT, 'node_modules/tesseract.js-core/tesseract-core.wasm.js'),
    gzip: false
  };
}

type Stage =
  | 'ocr'
  | 'ocr_correction'
  | 'text_extraction'
  | 'chunking'
  | 'embedding'
  | 'summary'
  | 'completed'
  | 'failed';

export async function processDocument(documentId: string, providedBinary?: Buffer, providedMimeType?: string) {
  const supabase = getServiceSupabase();
  const env = getServerEnv();
  const { data: document, error } = await supabase
    .from('documents')
    .select('*')
    .eq('id', documentId)
    .single();

  if (!document || error) {
    throw new Error('Documento não encontrado para processamento.');
  }

  await updateDocument(document.id, { status: 'processing', error_message: null });

  try {
    const binary = providedBinary ?? (await downloadDocumentBinary(document.storage_path));
    const mimeType = providedMimeType ?? document.mime_type ?? 'application/pdf';
    const initialExtraction = await withStage(document.id, 'text_extraction', async () =>
      detectExistingText(binary, mimeType)
    );

    let extraction: ExtractionResult | null = hasExtractedText(initialExtraction) ? initialExtraction : null;

    if (!extraction) {
      extraction = await withStage(document.id, 'ocr', async () => runTesseract(binary, mimeType));
    } else {
      await recordStage(document.id, 'ocr', 'completed', { skipped: true });
    }

    if (!hasExtractedText(extraction)) {
      throw new Error('Não foi possível extrair texto do documento (nem com OCR).');
    }

    const cameFromOcr = !hasExtractedText(initialExtraction);
    let finalText = extraction.text;
    if (cameFromOcr) {
      finalText = await withStage(document.id, 'ocr_correction', async () =>
        correctOcrTextWithLLM(extraction.text, document.title ?? document.original_filename ?? undefined)
      );
    } else {
      await recordStage(document.id, 'ocr_correction', 'completed', { skipped: true, reason: 'text_from_pdf' });
    }

    const chunks = await withStage(document.id, 'chunking', async () => {
      const baseChunks = chunkText(finalText);
      return enrichStructuredChunks(baseChunks, {
        documentTitle: document.title ?? document.original_filename,
        env
      });
    });
    const [chunkAttributes, docSemanticAttributes] = await Promise.all([
      Promise.all(
        chunks.map((chunk) =>
          buildSemanticAttributes(
            chunk.content,
            { title: document.title ?? document.original_filename },
            { useModel: false }
          )
        )
      ),
      buildSemanticAttributes(finalText, { title: document.title ?? document.original_filename }, { useModel: true })
    ]);
    const embeddings = await withStage(document.id, 'embedding', async () => embedTexts(chunks.map((c) => c.content)));

    if (embeddings.length !== chunks.length) {
      throw new Error('Número de embeddings diferente do número de chunks.');
    }

    const { error: deleteError } = await supabase.from('document_chunks').delete().eq('document_id', document.id);
    if (deleteError) {
      throw new Error(`Erro ao limpar chunks antigos: ${deleteError.message}`);
    }

    if (chunks.length) {
      const { error: insertError } = await supabase.from('document_chunks').insert(
        chunks.map((chunk, index) => ({
          document_id: document.id,
          chunk_index: chunk.chunkIndex,
          content: chunk.content,
          token_count: chunk.tokenCount,
          embedding: embeddings[index],
          page_number: null,
          section: null,
          metadata: buildChunkMetadata(chunk, chunkAttributes[index])
        }))
      );
      if (insertError) {
        throw new Error(`Erro ao salvar chunks: ${insertError.message}`);
      }
    }

    const summary = chunks.length
      ? await withStage(document.id, 'summary', async () =>
          generateSummaryFromText(document.title ?? document.original_filename, finalText)
        )
      : null;

    const totalTokens = chunks.reduce((acc, chunk) => acc + chunk.tokenCount, 0);
    const structuredOverview = buildStructuredOverview(chunks);

    const metadataUpdates: Record<string, unknown> = { semantic: docSemanticAttributes };
    if (structuredOverview.length) {
      metadataUpdates.structured_overview = structuredOverview;
    }

    await updateDocument(document.id, {
      status: 'ready',
      summary,
      num_pages: extraction.numPages,
      tokens_estimated: totalTokens,
      language: detectLanguage(finalText),
      metadata: mergeDocumentMetadata(document.metadata, metadataUpdates)
    });

    await recordStage(document.id, 'completed', 'completed', { chunkCount: chunks.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro desconhecido no pipeline';
    await updateDocument(document.id, { status: 'error', error_message: message });
    await recordStage(document.id, 'failed', 'failed', { reason: message });
    throw err;
  }
}

async function withStage<T>(documentId: string, stage: Stage, fn: () => Promise<T>) {
  await recordStage(documentId, stage, 'running');
  try {
    const result = await fn();
    await recordStage(documentId, stage, 'completed', {
      ...(typeof result === 'object' ? { detail: truncateForJson(result) } : {})
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'erro no estágio';
    await recordStage(documentId, stage, 'failed', { error: message });
    throw error;
  }
}

function truncateForJson(value: unknown): Json {
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > 1000) {
      return `${serialized.slice(0, 1000)}...`;
    }
    return JSON.parse(serialized) as Json;
  } catch {
    return String(value).slice(0, 1000);
  }
}

async function recordStage(documentId: string, stage: Stage, status: 'running' | 'completed' | 'failed', payload?: Json | null) {
  const supabase = getServiceSupabase();
  await supabase.from('processing_jobs').insert({
    document_id: documentId,
    stage,
    status,
    payload: payload ?? null
  });
}

async function updateDocument(documentId: string, data: Partial<DocumentsRow>) {
  const supabase = getServiceSupabase();
  const { error } = await supabase
    .from('documents')
    .update(data)
    .eq('id', documentId);

  if (error) {
    throw new Error(`Erro ao atualizar documento: ${error.message}`);
  }
}

async function detectExistingText(binary: Buffer, mimeType: string): Promise<ExtractionResult | null> {
  if (!mimeType) {
    return null;
  }

  if (mimeType.includes('pdf')) {
    try {
      return await extractTextWithPdfJs(binary, { throwOnEmpty: false });
    } catch (error) {
      console.warn('[pipeline] Falha ao extrair texto nativo do PDF, tentando OCR', error);
      return null;
    }
  }

  if (mimeType.startsWith('text/')) {
    const text = binary.toString('utf8').trim();
    return { text, numPages: 1 };
  }

  return null;
}

function detectLanguage(text: string): string {
  const latin = /[áéíóúãõâêîôûç]/i;
  if (latin.test(text)) {
    return 'pt-BR';
  }
  return 'en';
}

function mergeDocumentMetadata(existing: DocumentsRow['metadata'], updates: Record<string, unknown>): Json {
  const base = (existing && typeof existing === 'object' ? existing : {}) as Record<string, unknown>;
  return { ...base, ...updates } as Json;
}

async function enrichStructuredChunks(
  chunks: Chunk[],
  options: { documentTitle?: string | null; env: ReturnType<typeof getServerEnv> }
) {
  if (!options.env.ENABLE_STRUCTURED_BLOCK_ENRICHMENT) {
    return chunks;
  }
  const structuredTargets = chunks.filter(
    (chunk) => chunk.blockType === 'table' || chunk.blockType === 'graphic'
  );
  if (!structuredTargets.length) {
    return chunks;
  }

  const concurrency = Math.max(1, options.env.STRUCTURED_BLOCK_CONCURRENCY);
  for (let index = 0; index < structuredTargets.length; index += concurrency) {
    const batch = structuredTargets.slice(index, index + concurrency);
    await Promise.all(
      batch.map(async (chunk) => {
        try {
          const result = await normalizeStructuredBlockWithLLM({
            text: chunk.sourceText,
            type: chunk.blockType === 'table' ? 'table' : 'graphic',
            documentTitle: options.documentTitle ?? undefined,
            maxOutputTokens: options.env.STRUCTURED_BLOCK_MAX_TOKENS
          });
          if (!result) {
            return;
          }
          const combinedText = [result.summary, result.normalizedText]
            .filter((value): value is string => Boolean(value && value.trim().length))
            .join('\n\n')
            .trim();
          if (combinedText) {
            chunk.content = combinedText;
            chunk.tokenCount = estimateTokenCount(chunk.content);
          }
          chunk.structuredData = {
            type: chunk.blockType === 'table' ? 'table' : 'graphic',
            summary: result.summary ?? null,
            normalizedText: result.normalizedText ?? null,
            data: result.structuredJson ?? null,
            raw: chunk.sourceText
          };
        } catch (error) {
          console.warn('[pipeline] Falha ao enriquecer bloco estruturado', error);
        }
      })
    );
  }

  return chunks;
}

function buildChunkMetadata(chunk: Chunk, semanticAttributes: SemanticAttributes): Json {
  const structuredPayload: Json | null = chunk.structuredData
    ? {
        type: chunk.structuredData.type,
        summary: chunk.structuredData.summary ?? null,
        normalized_text: chunk.structuredData.normalizedText ?? null,
        data: (chunk.structuredData.data as Json | null) ?? null,
        raw_excerpt: chunk.structuredData.raw ? chunk.structuredData.raw.slice(0, 1800) : null
      }
    : null;

  const baseMetadata: Record<string, Json | undefined> = {
    source: 'pipeline',
    block_type: chunk.blockType,
    semantic: semanticAttributes
  };

  if (structuredPayload) {
    baseMetadata.structured = structuredPayload;
  } else if (chunk.sourceText) {
    baseMetadata.raw_excerpt = chunk.sourceText.slice(0, 800);
  }

  return baseMetadata;
}

function buildStructuredOverview(chunks: Chunk[]) {
  return chunks
    .filter((chunk) => chunk.structuredData)
    .map((chunk) => ({
      chunk_index: chunk.chunkIndex,
      type: chunk.blockType,
      summary: chunk.structuredData?.summary ?? null
    }));
}

export async function regenerateDocument(document: DocumentsRow) {
  const binary = await downloadDocumentBinary(document.storage_path);
  await processDocument(document.id, binary, document.mime_type ?? undefined);
}

export function estimateNotebookContextSize(text: string) {
  return estimateTokenCount(text);
}

async function extractTextWithPdfJs(
  buffer: Buffer,
  options: { throwOnEmpty?: boolean } = { throwOnEmpty: true }
): Promise<ExtractionResult> {
  const documentParams: DocumentInitParameters & { disableWorker?: boolean } = {
    data: toUint8Array(buffer),
    useSystemFonts: true,
    disableWorker: true
  };
  const task = getDocument(documentParams);
  const doc: PDFDocumentProxy = await task.promise;
  const numPages = doc.numPages;
  const sections: string[] = [];

  for (let pageNumber = 1; pageNumber <= numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const symbols = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .filter(Boolean)
      .join(' ')
      .trim();
    if (symbols) {
      sections.push(`\n\n[Page ${pageNumber}]\n${symbols}`);
    }
  }

  await doc.destroy();

  const normalized = sections.join('').trim();
  if (!normalized && options.throwOnEmpty !== false) {
    throw new Error(
      'Não foi possível extrair texto do PDF com pdfjs. Verifique se o arquivo contém texto selecionável.'
    );
  }

  return { text: normalized, numPages };
}

function hasExtractedText(result: ExtractionResult | null | undefined): result is ExtractionResult {
  return Boolean(result && result.text && result.text.trim().length > 0);
}

async function runTesseract(binary: Buffer, mimeType: string): Promise<ExtractionResult> {
  try {
    const { sources, numPages } = await prepareOcrSources(binary, mimeType);
    if (!sources.length) {
      throw new Error('Nenhuma página disponível para OCR.');
    }

    const { default: Tesseract } = await import('tesseract.js');
    const lang = /(png|jpe?g|webp|bmp|tif|pdf)/i.test(mimeType) ? 'por+eng' : 'eng';
    const pageTexts: string[] = [];

    for (const source of sources) {
      const result = await Tesseract.recognize(source.buffer, lang, getTesseractOptions());
      const recognized = result.data.text?.trim();
      if (recognized) {
        pageTexts.push(`\n\n[Page ${source.page}]\n${recognized}`);
      }
    }

    return {
      text: pageTexts.join('').trim(),
      numPages
    };
  } catch (error) {
    console.warn('[pipeline] Falha no OCR com Tesseract', error);
    throw error instanceof Error ? error : new Error('Falha ao executar OCR com Tesseract.');
  }
}

async function prepareOcrSources(
  binary: Buffer,
  mimeType: string
): Promise<{ sources: { buffer: Buffer; page: number }[]; numPages: number }> {
  if (/^image\//.test(mimeType)) {
    return { sources: [{ buffer: binary, page: 1 }], numPages: 1 };
  }

  if (mimeType.includes('pdf')) {
    const rendered = await renderPdfPagesToImages(binary);
    return {
      sources: rendered.pages,
      numPages: rendered.numPages
    };
  }

  throw new Error(`OCR disponível apenas para imagens ou PDFs. Tipo recebido: ${mimeType || 'desconhecido'}.`);
}

async function renderPdfPagesToImages(buffer: Buffer) {
  const params: DocumentInitParameters & { disableWorker?: boolean } = {
    data: toUint8Array(buffer),
    useSystemFonts: true,
    disableWorker: true
  };
  const doc = await getDocument(params).promise;
  const canvasFactory = new NodeCanvasFactory();
  const pages: { buffer: Buffer; page: number }[] = [];

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 2 });
    const canvasAndContext = canvasFactory.create(viewport.width, viewport.height);
    const renderContext = {
      canvasContext: canvasAndContext.context,
      canvas: canvasAndContext.canvas,
      viewport,
      canvasFactory
    } as unknown as Parameters<typeof page.render>[0];
    await page.render(renderContext).promise;
    const imageBuffer = canvasAndContext.canvas.toBuffer('image/png');
    pages.push({ buffer: imageBuffer, page: pageNumber });
    canvasFactory.destroy(canvasAndContext);
    page.cleanup();
  }

  await doc.destroy();

  return { pages, numPages: pages.length };
}

function toUint8Array(buffer: Buffer | Uint8Array) {
  if (Buffer.isBuffer(buffer)) {
    return new Uint8Array(buffer);
  }

  if (buffer instanceof Uint8Array) {
    return new Uint8Array(buffer);
  }

  const copy = Buffer.from(buffer);
  return new Uint8Array(copy);
}

class NodeCanvasFactory {
  create(width: number, height: number): CanvasAndContext {
    if (width <= 0 || height <= 0) {
      throw new Error('Canvas com dimensões inválidas');
    }
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Não foi possível criar contexto 2D para o canvas.');
    }
    return { canvas, context };
  }

  reset(target: CanvasAndContext, width: number, height: number) {
    if (!target) return;
    target.canvas.width = width;
    target.canvas.height = height;
  }

  destroy(target: CanvasAndContext) {
    if (!target) return;
    target.canvas.width = 0;
    target.canvas.height = 0;
  }
}
