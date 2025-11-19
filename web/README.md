# NotebookLM Clone — Plataforma de PDFs com RAG

Projeto baseado no PRD fornecido: upload de PDFs/imagems, pipeline de OCR + chunking + embeddings em Supabase (pgvector) e chat estilo NotebookLM com citações.

## Arquitetura

- **Next.js 14 (App Router)** — UI + APIs (upload, notebooks, chats, mensagens).
- **Supabase** — Storage, Postgres + pgvector. O schema completo está em `../supabase/schema.sql` (execute no SQL Editor do Supabase).
- **OpenAI** — Modelos para embeddings e chat (configuráveis via variáveis de ambiente).
- **Pipeline** — Implementado em `src/lib/pipeline.ts`, cobre extração (`pdfjs-dist`/`tesseract.js`), chunking, embeddings e resumo automático.

## Pré-requisitos

1. Criar um projeto no Supabase e executar `supabase/schema.sql` (isso cria tabelas, RLS e a função `match_chunks`).
2. Criar um bucket público chamado `documents` (ou outro nome e atualizar `SUPABASE_STORAGE_BUCKET`).
3. Obter uma API Key da [OpenAI](https://platform.openai.com/) e escolher os modelos desejados.
4. Todas as dependências necessárias para OCR/PDF já estão no `package.json` (`pdfjs-dist`, `tesseract.js`, `@napi-rs/canvas` e o polyfill de `DOMMatrix` via `@thednp/dommatrix`); basta rodar `npm install`.
5. Os arquivos de idioma do Tesseract ficam em `web/tessdata` (`eng.traineddata`, `por.traineddata`). Você pode adicionar outros idiomas colocando os `.traineddata` nesse diretório.

## Configuração

1. Copie `.env.example` para `.env.local` e preencha os valores:

```
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_STORAGE_BUCKET=documents
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL_CHAT=gpt-4.1-mini
OPENAI_MODEL_EMBEDDING=text-embedding-3-small
EMBEDDING_VECTOR_SIZE=1536
CHAT_MAX_OUTPUT_TOKENS=2200
SUMMARY_MAX_OUTPUT_TOKENS=800
RAG_MATCH_COUNT=12
ENABLE_OCR_CORRECTION=true
OCR_CORRECTION_MAX_TOKENS=6000
OCR_CORRECTION_BATCH_SIZE=3
ENABLE_STRUCTURED_BLOCK_ENRICHMENT=true
STRUCTURED_BLOCK_MAX_TOKENS=1800
STRUCTURED_BLOCK_CONCURRENCY=2
```

> As chaves da OpenAI são opcionais para carregar a UI/listagens, mas **obrigatórias** para processar documentos (embeddings/resumos) e usar o chat. Se deixar `OPENAI_API_KEY` em branco, o upload retornará erro informando que a chave é necessária.

> `EMBEDDING_VECTOR_SIZE` precisa combinar com a definição do campo `document_chunks.embedding`. O schema padrão usa `vector(1536)` (compatível com `text-embedding-3-small`). Se quiser usar um modelo com mais dimensões, ajuste esse valor **e** atualize o schema do Supabase (lembrando que índices `ivfflat` do pgvector aceitam no máximo 2000 dimensões).

> O projeto roda em modo single-tenant: não há autenticação Supabase. Todas as tabelas ficam acessíveis apenas pelo service role configurado no backend.

> `ENABLE_OCR_CORRECTION` e `ENABLE_STRUCTURED_BLOCK_ENRICHMENT` controlam as etapas adicionais introduzidas para correção de OCR e enriquecimento de tabelas/gráficos. Se quiser economizar tokens, basta colocar `false` nessas flags. Os limites (`*_MAX_TOKENS`, `*_BATCH_SIZE`, `STRUCTURED_BLOCK_CONCURRENCY`) ajudam a ajustar custo/tempo conforme o tamanho dos documentos.

2. Instale dependências:

```bash
cd web
npm install
```

3. Rode em desenvolvimento:

```bash
npm run dev
```

A aplicação estará em `http://localhost:3000`.

## Fluxo principal

1. **Upload** — selecione PDF/JPG/PNG. O arquivo é enviado ao storage do Supabase e o pipeline é disparado.
2. **Pipeline** — verifica se o arquivo já contém texto (PDF via `pdfjs-dist` ou texto plano). Se não houver, renderiza cada página (PDF → bitmap com `pdfjs-dist` + `@napi-rs/canvas`) e dispara o OCR (Tesseract usando os `.traineddata` locais em `tessdata`). Quando o texto vem do OCR, ele passa por uma etapa opcional de correção usando o LLM (paginação em lotes para evitar exceder o limite de tokens). Em seguida o chunking semântico respeita blocos inteiros de tabelas/quadro/gráficos, gera versões textual + JSON resumido para esses blocos, produz embeddings (OpenAI), cria um índice semântico (keywords, valores, datas) e grava tudo no pgvector/`document_chunks`, atualiza o registro em `documents` com metadados inteligentes e notifica o progresso via `processing_jobs`.
   - Ordem: verificação de texto → OCR (quando necessário) → extração de texto consolidado → chunking semântico + índices → embeddings → persistência no pgvector → atualização do documento → UI recebe status via `processing_jobs` + campo `status`.
3. **Notebooks** — agrupe documentos e crie quantos notebooks quiser, adicionando documentos existentes.
4. **Chat** — cada notebook pode ter múltiplas conversas. A API `runRagChat` consulta `match_chunks` (limiar 0.2, até 12 chunks), reranqueia trechos com heurísticas, hidrata metadados/vizinhos, FORÇA cobertura de todos os documentos do notebook (busca chunks representativos quando algo ficou de fora), injeta resumos/document inventory + correções previamente fornecidas por humanos e envia o prompt detalhado ao modelo (`gpt-4.1-mini`, respostas até ~2.2k tokens). Depois a resposta passa por uma revisão automática (modelo auxiliar em JSON) que aponta lacunas, citações obrigatórias e números a conferir.
5. **Citações** — as referências retornam no payload `citations` da mensagem, exibidas na UI.
6. **Feedback** — a UI expõe botões “Útil / Incompleta / Incorreta”, captura notas e versões corrigidas e envia para `/api/chats/[id]/feedback`. Esses pares pergunta→resposta alimentam o dataset `chat_feedback` (com embeddings próprios), permitindo reuso como contexto adicional e facilitando extração para futuros fine-tunes.

## Loop de reforço e feedback

- **Contexto enriquecido** — a função `runRagChat` agora injeta: inventário completo do notebook, resumos semânticos dos documentos, chunks relevantes + trechos “forçados” para cobrir 100% das fontes, além de correções humanas recuperadas via `match_feedback_samples` (pgvector em `chat_feedback.question_embedding`).
- **Reclassificação por perguntas reais** — cada turno registrado grava palavras-chave da pergunta em `chunk_question_signals` (ligando chunk × notebook × keywords). Esses sinais podem ser agregados para repriorizar chunk metadata, detectar lacunas e até automatizar merges.
- **Telemetria detalhada** — `rag_turn_telemetry` guarda o prompt versionado, chunks utilizados (origem `retrieved|forced`), cobertura, contexto de feedback aplicado e o veredito da revisão automática. Facilita dashboards ou análises offline.
- **Feedback estruturado** — `/api/chats/[id]/feedback` valida se a mensagem pertence ao chat, encontra a pergunta relacionada, gera embedding e salva rating/notas/resposta revisada. As revisões são reaproveitadas automaticamente como contexto adicional quando perguntas semelhantes chegarem.
- **Revisão automática** — toda resposta passa por um segundo modelo com instruções rígidas para retornar JSON. O resultado fica no metadata (`auto_review`) e é exibido na UI, além de ser anexado à mensagem para auditoria.

## Estrutura relevante

- `src/app/api/documents` — upload/listagem + disparo do pipeline.
- `src/app/api/notebooks` e `.../[id]/documents` — CRUD básico.
- `src/app/api/chats` e `.../[id]/messages` — gestão de chat + execução do RAG.
- `src/lib/*` — utilitários (env, supabase, storage, chunking, embeddings, RAG, pipeline).
- `src/app/page.tsx` — dashboard NotebookLM-like (upload, notebooks, chats, UI do chat).

## Testes e lint

```bash
npm run lint
```

## Próximos passos sugeridos

- Plugar autenticação real do Supabase quando precisar multiusuário.
- Implementar fila assíncrona (e.g., Supabase Functions, n8n ou workers dedicados) em vez de processar no request.
- Renderizar PDFs e highlights das páginas citadas.
- Adicionar indicadores de progresso usando os registros em `processing_jobs`.
