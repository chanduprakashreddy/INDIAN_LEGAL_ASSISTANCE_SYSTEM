create extension if not exists vector;

-- ============ Legal corpus (RAG) ============
create table public.legal_chunks (
  id uuid primary key default gen_random_uuid(),
  external_id text,
  act_name text not null,
  act_year int,
  section text,
  chapter text,
  source_url text,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  embedding vector(3072),
  embedding_model text,
  content_tsv tsvector generated always as (to_tsvector('english', coalesce(act_name,'') || ' ' || coalesce(section,'') || ' ' || content)) stored,
  created_at timestamptz not null default now()
);

create index legal_chunks_embedding_idx
  on public.legal_chunks using hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops);
create index legal_chunks_tsv_idx on public.legal_chunks using gin (content_tsv);
create index legal_chunks_act_idx on public.legal_chunks (act_name);
create unique index legal_chunks_external_id_idx on public.legal_chunks (external_id) where external_id is not null;

grant all on public.legal_chunks to service_role;
alter table public.legal_chunks enable row level security;

-- ============ India Code fallback cache ============
create table public.indiacode_cache (
  id uuid primary key default gen_random_uuid(),
  cache_key text not null unique,
  payload jsonb not null,
  fetched_at timestamptz not null default now()
);
grant all on public.indiacode_cache to service_role;
alter table public.indiacode_cache enable row level security;

-- ============ Case workspace ============
create table public.matters (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  title text not null,
  category text,
  description text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index matters_session_idx on public.matters (session_id, created_at desc);
grant all on public.matters to service_role;
alter table public.matters enable row level security;

-- ============ Chat ============
create table public.chat_threads (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  matter_id uuid references public.matters(id) on delete set null,
  title text not null default 'New consultation',
  language text not null default 'en',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index chat_threads_session_idx on public.chat_threads (session_id, updated_at desc);
grant all on public.chat_threads to service_role;
alter table public.chat_threads enable row level security;

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.chat_threads(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null,
  citations jsonb not null default '[]'::jsonb,
  grounding text not null default 'none',
  created_at timestamptz not null default now()
);
create index chat_messages_thread_idx on public.chat_messages (thread_id, created_at);
grant all on public.chat_messages to service_role;
alter table public.chat_messages enable row level security;

-- ============ Uploaded / analysed documents ============
create table public.user_documents (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  matter_id uuid references public.matters(id) on delete set null,
  title text not null,
  mime_type text,
  file_path text not null,
  enhanced_path text,
  extracted_text text,
  cleaned_text text,
  analysis jsonb,
  status text not null default 'uploaded',
  created_at timestamptz not null default now()
);
create index user_documents_session_idx on public.user_documents (session_id, created_at desc);
grant all on public.user_documents to service_role;
alter table public.user_documents enable row level security;

-- ============ Generated documents ============
create table public.generated_documents (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  matter_id uuid references public.matters(id) on delete set null,
  doc_type text not null,
  title text not null,
  language text not null default 'en',
  fields jsonb not null default '{}'::jsonb,
  content text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index generated_documents_session_idx on public.generated_documents (session_id, created_at desc);
grant all on public.generated_documents to service_role;
alter table public.generated_documents enable row level security;

-- ============ Hybrid retrieval ============
create or replace function public.match_legal_chunks(
  query_embedding vector(3072),
  query_text text,
  match_count int default 8
)
returns table (
  id uuid,
  act_name text,
  act_year int,
  section text,
  chapter text,
  source_url text,
  content text,
  metadata jsonb,
  similarity double precision,
  keyword_rank double precision,
  score double precision
)
language sql
stable
security definer
set search_path = public
as $$
  with vec as (
    select
      c.id,
      1 - (c.embedding::halfvec(3072) <=> query_embedding::halfvec(3072)) as similarity
    from public.legal_chunks c
    where c.embedding is not null
    order by c.embedding::halfvec(3072) <=> query_embedding::halfvec(3072)
    limit greatest(match_count * 4, 40)
  ),
  kw as (
    select
      c.id,
      ts_rank(c.content_tsv, websearch_to_tsquery('english', query_text)) as keyword_rank
    from public.legal_chunks c
    where query_text is not null
      and query_text <> ''
      and c.content_tsv @@ websearch_to_tsquery('english', query_text)
    order by keyword_rank desc
    limit greatest(match_count * 4, 40)
  ),
  merged as (
    select
      coalesce(vec.id, kw.id) as id,
      coalesce(vec.similarity, 0)::double precision as similarity,
      coalesce(kw.keyword_rank, 0)::double precision as keyword_rank
    from vec
    full outer join kw on kw.id = vec.id
  )
  select
    c.id,
    c.act_name,
    c.act_year,
    c.section,
    c.chapter,
    c.source_url,
    c.content,
    c.metadata,
    m.similarity,
    m.keyword_rank,
    (m.similarity * 0.75 + least(m.keyword_rank, 1.0) * 0.25) as score
  from merged m
  join public.legal_chunks c on c.id = m.id
  order by score desc
  limit match_count;
$$;

revoke all on function public.match_legal_chunks(vector, text, int) from public;
grant execute on function public.match_legal_chunks(vector, text, int) to service_role;