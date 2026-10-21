import { randomUUID } from "node:crypto";
import {
  AiJobSchema,
  GenerateCardsCommandSchema,
  type AiJob,
  type AiJobEvent,
  type CreateAiJobInput,
  type GenerateCardsCommand,
} from "@taskflow/shared";
import type { z } from "zod";
import { BOARD_ID } from "./board-id.ts";
import { query, withTransaction } from "./db.ts";
import { HttpError } from "./http.ts";
import { AI_CARD_NAMESPACE, uuidV5 } from "./uuid.ts";

export const PROMPT_VERSION = "v1";

/** Mesmo passo de web/src/lib/position.ts: os cartões gerados entram no fim da coluna. */
const POSITION_STEP = 1024;

type AiJobRow = Omit<z.input<typeof AiJobSchema>, "createdAt" | "updatedAt" | "completedAt"> & {
  boardId: string;
  correlationId: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

const JOB_COLUMNS = `id, board_id as "boardId", status, input, target_column_id as "targetColumnId",
  max_cards as "maxCards", card_ids as "cardIds", error, provider, model,
  correlation_id as "correlationId", created_at as "createdAt", updated_at as "updatedAt",
  completed_at as "completedAt"`;

const TERMINAL_STATUSES = ["succeeded", "failed"] as const;

function toAiJob(row: AiJobRow): AiJob {
  return AiJobSchema.parse({
    id: row.id,
    status: row.status,
    input: row.input,
    targetColumnId: row.targetColumnId,
    maxCards: row.maxCards,
    cardIds: row.cardIds,
    error: row.error,
    provider: row.provider,
    model: row.model,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  });
}

/**
 * Cria o job em 'pending_publish'. Repetir a mesma idempotencyKey com o mesmo
 * conteúdo devolve o job existente (`created: false`); com outro conteúdo, 409.
 */
export async function createAiJob(
  body: CreateAiJobInput,
  correlationId: string,
): Promise<{ job: AiJob; created: boolean }> {
  const column = await query("select 1 from columns where id = $1 and board_id = $2", [body.targetColumnId, BOARD_ID]);
  if (column.rows.length === 0) throw new HttpError(404, "Coluna de destino não encontrada");

  const inserted = await query<AiJobRow>(
    `insert into ai_jobs (board_id, target_column_id, idempotency_key, input, max_cards, correlation_id)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (idempotency_key) do nothing
     returning ${JOB_COLUMNS}`,
    [BOARD_ID, body.targetColumnId, body.idempotencyKey, body.input, body.maxCards, correlationId],
  );
  const row = inserted.rows[0];
  if (row) return { job: toAiJob(row), created: true };

  const existing = await query<AiJobRow>(
    `select ${JOB_COLUMNS} from ai_jobs where idempotency_key = $1`,
    [body.idempotencyKey],
  );
  const job = existing.rows[0];
  if (!job) throw new Error("Job com a chave de idempotência sumiu durante a criação");
  if (job.input !== body.input || job.targetColumnId !== body.targetColumnId || job.maxCards !== body.maxCards) {
    throw new HttpError(409, "Esta chave de idempotência já foi usada com outro conteúdo");
  }
  return { job: toAiJob(job), created: false };
}

export async function getAiJob(id: string): Promise<AiJob | null> {
  const result = await query<AiJobRow>(`select ${JOB_COLUMNS} from ai_jobs where id = $1`, [id]);
  const row = result.rows[0];
  return row ? toAiJob(row) : null;
}

/** Monta o comando do RabbitMQ a partir do job salvo (formato validado pelo contrato). */
function toCommand(row: AiJobRow, targetColumnId: string): GenerateCardsCommand {
  return GenerateCardsCommandSchema.parse({
    schemaVersion: 1,
    type: "cards.generate",
    messageId: randomUUID(),
    jobId: row.id,
    correlationId: row.correlationId,
    createdAt: new Date().toISOString(),
    payload: {
      boardId: row.boardId,
      targetColumnId,
      input: row.input,
      maxCards: row.maxCards,
      locale: "pt-BR",
      promptVersion: PROMPT_VERSION,
    },
  });
}

export type PublishCommand = (command: GenerateCardsCommand) => Promise<void>;

/**
 * Publica um lote de jobs 'pending_publish' (outbox). Cada job só vira 'queued'
 * depois da confirmação do broker; se o broker falhar no meio do lote, os já
 * confirmados são marcados e os demais continuam pendentes para a próxima vez.
 * O `skip locked` deixa várias réplicas da API publicarem sem disputar o mesmo job.
 */
export async function publishPendingJobs(
  publish: PublishCommand,
  batchSize: number,
): Promise<{ published: GenerateCardsCommand[]; selected: number; error: unknown }> {
  return withTransaction(async (client) => {
    const pending = await client.query<AiJobRow>(
      `select ${JOB_COLUMNS} from ai_jobs where status = 'pending_publish'
       order by created_at, id limit $1 for update skip locked`,
      [batchSize],
    );
    const published: GenerateCardsCommand[] = [];
    let error: unknown = null;
    for (const row of pending.rows) {
      if (row.targetColumnId === null) {
        await client.query(
          `update ai_jobs set status = 'failed', error = $2, completed_at = now(), updated_at = now() where id = $1`,
          [row.id, "A coluna de destino foi excluída antes de o pedido ser enviado."],
        );
        continue;
      }
      const command = toCommand(row, row.targetColumnId);
      try {
        await publish(command);
      } catch (publishError: unknown) {
        error = publishError;
        break;
      }
      published.push(command);
    }
    if (published.length > 0) {
      await client.query(
        `update ai_jobs set status = 'queued', published_at = now(), updated_at = now()
         where id = any($1::uuid[]) and status = 'pending_publish'`,
        [published.map((command) => command.jobId)],
      );
    }
    return { published, selected: pending.rows.length, error };
  });
}

export type ApplyOutcome = "applied" | "ignored";

/**
 * Aplica um evento do worker. Entrega "pelo menos uma vez": o mesmo evento pode
 * chegar de novo, e eventos atrasados não podem fazer um job terminal regredir.
 */
export async function applyAiJobEvent(event: AiJobEvent): Promise<ApplyOutcome> {
  switch (event.type) {
    case "cards.generation_started": {
      const result = await query(
        `update ai_jobs set status = 'processing', worker = $2, updated_at = now()
         where id = $1 and status in ('pending_publish', 'queued')`,
        [event.jobId, event.worker],
      );
      return result.rowCount ? "applied" : "ignored";
    }
    case "cards.generation_failed": {
      const result = await query(
        `update ai_jobs set status = 'failed', error = $2, provider = $3, model = $4, worker = $5,
           completed_at = now(), updated_at = now()
         where id = $1 and status <> all($6::text[])`,
        [event.jobId, event.payload.message, event.provider, event.model, event.worker, TERMINAL_STATUSES],
      );
      return result.rowCount ? "applied" : "ignored";
    }
    case "cards.generated":
      return applyGeneratedCards(event);
  }
}

async function applyGeneratedCards(event: Extract<AiJobEvent, { type: "cards.generated" }>): Promise<ApplyOutcome> {
  return withTransaction(async (client) => {
    const locked = await client.query<{ status: string; targetColumnId: string | null; maxCards: number }>(
      `select status, target_column_id as "targetColumnId", max_cards as "maxCards"
       from ai_jobs where id = $1 for update`,
      [event.jobId],
    );
    const job = locked.rows[0];
    if (!job || TERMINAL_STATUSES.some((status) => status === job.status)) return "ignored";

    if (job.targetColumnId === null) {
      await client.query(
        `update ai_jobs set status = 'failed', error = $2, provider = $3, model = $4, worker = $5,
           completed_at = now(), updated_at = now() where id = $1`,
        [event.jobId, "A coluna de destino foi excluída antes de os cartões ficarem prontos.",
          event.provider, event.model, event.worker],
      );
      return "applied";
    }

    const cards = event.payload.cards.slice(0, job.maxCards);
    // IDs determinísticos: reaplicar o mesmo resultado não duplica cartões.
    const ids = cards.map((_, index) => uuidV5(`${event.jobId}:${index}`, AI_CARD_NAMESPACE));
    await client.query(
      `insert into cards (id, column_id, title, description, position)
       select card.id, $1, card.title, card.description,
         coalesce((select max(position) from cards where column_id = $1), 0) + card.ord * $5
       from unnest($2::uuid[], $3::text[], $4::text[]) with ordinality as card(id, title, description, ord)
       on conflict (id) do nothing`,
      [job.targetColumnId, ids, cards.map((card) => card.title), cards.map((card) => card.description), POSITION_STEP],
    );
    await client.query(
      `update ai_jobs set status = 'succeeded', card_ids = $2, provider = $3, model = $4, worker = $5,
         error = null, completed_at = now(), updated_at = now() where id = $1`,
      [event.jobId, ids, event.provider, event.model, event.worker],
    );
    return "applied";
  });
}
