import { z } from 'zod';

type EnvShape = z.infer<typeof envSchema>;

declare global {
  var __envCache: EnvShape | undefined;
}

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_STORAGE_BUCKET: z.string().default('documents'),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_MODEL_CHAT: z.string().default('gpt-4.1-mini'),
  OPENAI_MODEL_EMBEDDING: z.string().default('text-embedding-3-small'),
  EMBEDDING_VECTOR_SIZE: z.coerce.number().int().positive().default(1536),
  CHAT_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(2200),
  SUMMARY_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(800),
  RAG_MATCH_COUNT: z.coerce.number().int().positive().default(12)
});

export function getServerEnv(): EnvShape {
  if (!globalThis.__envCache) {
    const parsed = envSchema.parse({
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      SUPABASE_STORAGE_BUCKET: process.env.SUPABASE_STORAGE_BUCKET,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
      OPENAI_MODEL_CHAT: process.env.OPENAI_MODEL_CHAT,
      OPENAI_MODEL_EMBEDDING: process.env.OPENAI_MODEL_EMBEDDING,
      EMBEDDING_VECTOR_SIZE: process.env.EMBEDDING_VECTOR_SIZE,
      CHAT_MAX_OUTPUT_TOKENS: process.env.CHAT_MAX_OUTPUT_TOKENS,
      SUMMARY_MAX_OUTPUT_TOKENS: process.env.SUMMARY_MAX_OUTPUT_TOKENS,
      RAG_MATCH_COUNT: process.env.RAG_MATCH_COUNT
    });
    globalThis.__envCache = parsed;
  }

  return globalThis.__envCache;
}
