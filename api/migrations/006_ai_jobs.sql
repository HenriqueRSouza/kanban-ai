-- Jobs do "Agente de IA". A tabela também funciona como outbox: o job nasce
-- em 'pending_publish' na mesma transação do pedido HTTP, e o publicador do
-- Serviço A só o marca como 'queued' depois que o RabbitMQ confirma a mensagem.
-- Assim, nenhum pedido se perde se o broker estiver fora ou se a API cair
-- entre o commit e a publicação.
create table if not exists ai_jobs (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references boards(id) on delete cascade,
  -- Se a coluna for excluída enquanto o job espera, o resultado vira falha controlada.
  target_column_id uuid references columns(id) on delete set null,
  idempotency_key uuid not null unique,
  input text not null check (length(input) between 10 and 8000),
  max_cards integer not null check (max_cards between 1 and 20),
  status text not null default 'pending_publish'
    check (status in ('pending_publish', 'queued', 'processing', 'succeeded', 'failed')),
  error text,
  card_ids uuid[] not null default '{}',
  provider text,
  model text,
  worker text,
  correlation_id text not null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists ai_jobs_pending_publish_idx
  on ai_jobs(created_at) where status = 'pending_publish';
