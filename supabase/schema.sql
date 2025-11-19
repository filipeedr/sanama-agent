-- Schema for NotebookLM-style PDF intelligence platform (single-tenant, sem autenticação)

create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";
create extension if not exists "vector";

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$ language plpgsql;

create table if not exists public.documents (
  id uuid primary key default uuid_generate_v4(),
  title text,
  original_filename text not null,
  storage_path text not null,
  mime_type text,
  num_pages integer,
  status text not null default 'pending' check (status in ('pending','processing','ready','error')),
  language text,
  summary text,
  metadata jsonb default '{}'::jsonb,
  error_message text,
  tokens_estimated integer,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists documents_status_idx on public.documents(status);

create trigger documents_updated_at
before update on public.documents
for each row execute procedure public.set_updated_at();

-- Função para validar o limite de 50 documentos
create or replace function public.check_document_limit()
returns trigger as $$
declare
  current_count integer;
begin
  -- Conta o número total de documentos
  select count(*) into current_count from public.documents;
  
  -- Se já atingiu o limite de 50, bloqueia a inserção
  if current_count >= 50 then
    raise exception 'Limite de 50 documentos atingido. Exclua documentos antes de adicionar novos.';
  end if;
  
  return new;
end;
$$ language plpgsql;

-- Trigger para validar o limite antes de inserir
create trigger documents_limit_check
before insert on public.documents
for each row execute procedure public.check_document_limit();

create table if not exists public.document_chunks (
  id bigserial primary key,
  document_id uuid not null references public.documents(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  token_count integer,
  embedding vector(1536),
  page_number integer,
  section text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists document_chunks_document_chunk_idx
  on public.document_chunks(document_id, chunk_index);
create index if not exists document_chunks_embedding_idx
  on public.document_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

create table if not exists public.notebooks (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  description text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create trigger notebooks_updated_at
before update on public.notebooks
for each row execute procedure public.set_updated_at();

create table if not exists public.notebook_documents (
  notebook_id uuid not null references public.notebooks(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  added_at timestamptz not null default timezone('utc', now()),
  primary key (notebook_id, document_id)
);

create index if not exists notebook_documents_document_idx on public.notebook_documents(document_id);

create table if not exists public.chats (
  id uuid primary key default uuid_generate_v4(),
  notebook_id uuid references public.notebooks(id) on delete set null,
  title text,
  status text not null default 'active' check (status in ('active','archived')),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  last_message_at timestamptz
);

create trigger chats_updated_at
before update on public.chats
for each row execute procedure public.set_updated_at();

create table if not exists public.chat_messages (
  id uuid primary key default uuid_generate_v4(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  role text not null check (role in ('system','user','assistant','tool')),
  content text not null,
  citations jsonb default '[]'::jsonb,
  token_usage jsonb default '{}'::jsonb,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists chat_messages_chat_id_idx on public.chat_messages(chat_id, created_at);

create table if not exists public.chat_feedback (
  id uuid primary key default uuid_generate_v4(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  notebook_id uuid not null references public.notebooks(id) on delete cascade,
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  user_message_id uuid references public.chat_messages(id) on delete set null,
  rating text not null check (rating in ('useful','incomplete','incorrect')),
  question text not null,
  answer text not null,
  notes text,
  revised_answer text,
  applied_chunk_ids bigint[] default '{}'::bigint[],
  question_embedding vector(1536),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists chat_feedback_notebook_idx on public.chat_feedback(notebook_id);
create index if not exists chat_feedback_message_idx on public.chat_feedback(message_id);
create index if not exists chat_feedback_question_embedding_idx
  on public.chat_feedback using ivfflat (question_embedding vector_cosine_ops) with (lists = 50);

create table if not exists public.chunk_question_signals (
  id uuid primary key default uuid_generate_v4(),
  chunk_id bigint not null references public.document_chunks(id) on delete cascade,
  notebook_id uuid not null references public.notebooks(id) on delete cascade,
  question text not null,
  keywords text[],
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists chunk_question_signals_chunk_idx on public.chunk_question_signals(chunk_id);
create index if not exists chunk_question_signals_notebook_idx on public.chunk_question_signals(notebook_id);

create table if not exists public.rag_turn_telemetry (
  id uuid primary key default uuid_generate_v4(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  notebook_id uuid not null references public.notebooks(id) on delete cascade,
  user_message text not null,
  answer_preview text,
  retrieved_chunks jsonb default '[]'::jsonb,
  coverage jsonb default '{}'::jsonb,
  auto_review jsonb default '{}'::jsonb,
  feedback_context jsonb default '[]'::jsonb,
  prompt_version text,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists rag_turn_telemetry_chat_idx on public.rag_turn_telemetry(chat_id, created_at);

create table if not exists public.processing_jobs (
  id uuid primary key default uuid_generate_v4(),
  document_id uuid not null references public.documents(id) on delete cascade,
  stage text not null check (stage in ('upload','ocr','ocr_correction','text_extraction','chunking','embedding','summary','completed','failed')),
  status text not null default 'pending' check (status in ('pending','running','completed','failed')),
  payload jsonb default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists processing_jobs_document_idx on public.processing_jobs(document_id);

create trigger processing_jobs_updated_at
before update on public.processing_jobs
for each row execute procedure public.set_updated_at();

create or replace function public.match_chunks(
  in_notebook_id uuid,
  query_embedding vector(1536),
  match_count int default 8,
  similarity_threshold double precision default 0.25
)
returns table (
  document_id uuid,
  chunk_id bigint,
  content text,
  page_number integer,
  similarity double precision
) as $$
  select dc.document_id,
         dc.id as chunk_id,
         dc.content,
         dc.page_number,
         1 - (dc.embedding <=> query_embedding) as similarity
    from public.document_chunks dc
    join public.notebook_documents nd on nd.document_id = dc.document_id
   where nd.notebook_id = in_notebook_id
     and dc.embedding <=> query_embedding <= (1 - similarity_threshold)
   order by dc.embedding <=> query_embedding
   limit match_count;
$$ language sql stable;

create or replace function public.match_feedback_samples(
  in_notebook_id uuid,
  query_embedding vector(1536),
  match_count int default 3,
  similarity_threshold double precision default 0.25
)
returns table (
  id uuid,
  question text,
  revised_answer text,
  notes text,
  similarity double precision
) as $$
  select cf.id,
         cf.question,
         cf.revised_answer,
         cf.notes,
         1 - (cf.question_embedding <=> query_embedding) as similarity
    from public.chat_feedback cf
   where cf.notebook_id = in_notebook_id
     and cf.question_embedding is not null
     and cf.revised_answer is not null
     and cf.question_embedding <=> query_embedding <= (1 - similarity_threshold)
   order by cf.question_embedding <=> query_embedding
   limit match_count;
$$ language sql stable;

-- RLS desativado (single tenant)
alter table public.documents disable row level security;
alter table public.document_chunks disable row level security;
alter table public.notebooks disable row level security;
alter table public.notebook_documents disable row level security;
alter table public.chats disable row level security;
alter table public.chat_messages disable row level security;
alter table public.processing_jobs disable row level security;
alter table public.chat_feedback disable row level security;
alter table public.chunk_question_signals disable row level security;
alter table public.rag_turn_telemetry disable row level security;
