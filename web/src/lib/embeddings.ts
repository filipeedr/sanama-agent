import { getServerEnv } from './env';

interface EmbeddingResponse {
  data: { embedding: number[] }[];
}

function normalizeEmbeddingDimension(embedding: number[], dimension: number, warn: (message: string) => void) {
  if (embedding.length === dimension) {
    return embedding;
  }

  warn(`[embeddings] Ajustando embedding de ${embedding.length} para ${dimension} dimensões. Atualize EMBEDDING_VECTOR_SIZE ou o schema do banco para evitar essa conversão.`);

  if (embedding.length > dimension) {
    return embedding.slice(0, dimension);
  }

  const padded = embedding.slice();
  while (padded.length < dimension) {
    padded.push(0);
  }
  return padded;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const env = getServerEnv();
  if (!env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY não configurada. Defina-a antes de gerar embeddings.');
  }

  const response = await fetch(`${env.OPENAI_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL_EMBEDDING,
      input: texts
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Erro ao gerar embeddings: ${body}`);
  }

  const data = (await response.json()) as EmbeddingResponse;
  const preserveLog = createOnceLogger();
  const expectedDimension = env.EMBEDDING_VECTOR_SIZE;
  return data.data.map((item) => normalizeEmbeddingDimension(item.embedding, expectedDimension, preserveLog));
}

function createOnceLogger() {
  let logged = false;
  return (message: string) => {
    if (!logged) {
      console.warn(message);
      logged = true;
    }
  };
}
