import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  AI_MESSAGING,
  AiJobSchema,
  ApiErrorSchema,
  GenerateCardsCommandSchema,
  assertAiTopology,
  type AiJob,
  type AiJobEvent,
  type GenerateCardsCommand,
} from "@taskflow/shared";
import { connect, type Channel, type ChannelModel } from "amqplib";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyAiJobEvent, publishPendingJobs } from "../src/ai-jobs.ts";
import { createApp } from "../src/app.ts";
import { BOARD_ID } from "../src/board-id.ts";
import { pool, query } from "../src/db.ts";
import { connectBroker, type Broker } from "../src/messaging/broker.ts";
import { createOutbox, type Outbox } from "../src/messaging/outbox.ts";
import { startResultsConsumer } from "../src/messaging/results.ts";

const columnIds: string[] = [];

async function createColumn(title: string): Promise<string> {
  const id = randomUUID();
  columnIds.push(id);
  await query("insert into columns (id, board_id, title, position) values ($1, $2, $3, 99999)", [id, BOARD_ID, title]);
  return id;
}

async function jobRow(id: string) {
  const result = await query<{ status: string; error: string | null; worker: string | null; correlationId: string }>(
    `select status, error, worker, correlation_id as "correlationId" from ai_jobs where id = $1`, [id]);
  return result.rows[0];
}

function generatedEvent(command: Pick<GenerateCardsCommand, "jobId" | "correlationId">, titles: string[]): AiJobEvent {
  return {
    schemaVersion: 1, type: "cards.generated", messageId: randomUUID(), jobId: command.jobId,
    correlationId: command.correlationId, createdAt: new Date().toISOString(), worker: "worker-teste",
    provider: "ollama", model: "qwen3:1.7b", durationMs: 42,
    payload: { cards: titles.map((title) => ({ title, description: `Descrição de ${title}` })) },
  };
}

afterAll(async () => {
  try {
    await query("delete from ai_jobs where target_column_id = any($1::uuid[]) or target_column_id is null", [columnIds]);
    await query("delete from columns where id = any($1::uuid[])", [columnIds]);
  } finally {
    await pool.end();
  }
});

describe.skipIf(!process.env.DATABASE_URL)("Jobs do Agente de IA com PostgreSQL real", () => {
  let created = 0;
  const app = createApp({ onAiJobCreated: () => { created += 1; } });
  let columnId: string;

  beforeAll(async () => {
    const migration = await readFile(new URL("../migrations/006_ai_jobs.sql", import.meta.url), "utf8");
    await query(migration);
    await query(migration);
    columnId = await createColumn("Gerados pela IA");
    await query("insert into cards (id, column_id, title, position) values ($1, $2, 'Já existia', 2048)", [randomUUID(), columnId]);
  });

  function postJob(body: Record<string, unknown>, requestId?: string) {
    const req = request(app).post("/api/ai/jobs");
    if (requestId) req.set("X-Request-Id", requestId);
    return req.send({ input: "Como aluno, quero gerar cartões a partir do planejamento", targetColumnId: columnId, ...body });
  }

  it("cria o job pendente com 202, consulta pelo GET e repete a mesma chave com 200", async () => {
    const idempotencyKey = randomUUID();
    const first = await postJob({ idempotencyKey, maxCards: 3 }, "req-abc").expect(202);
    const job = AiJobSchema.parse(first.body);
    expect(job).toMatchObject({ status: "pending_publish", maxCards: 3, cardIds: [], targetColumnId: columnId });
    expect(first.headers.location).toBe(`/api/ai/jobs/${job.id}`);
    expect((await jobRow(job.id))?.correlationId).toBe("req-abc");
    expect(created).toBe(1);

    const again = await postJob({ idempotencyKey, maxCards: 3 }).expect(200);
    expect(AiJobSchema.parse(again.body).id).toBe(job.id);
    expect(created).toBe(1);

    const fetched = await request(app).get(`/api/ai/jobs/${job.id}`).expect(200);
    expect(AiJobSchema.parse(fetched.body)).toEqual(job);
  });

  it("recusa chave reutilizada com outro conteúdo, coluna inexistente, corpo e IDs inválidos", async () => {
    const idempotencyKey = randomUUID();
    await postJob({ idempotencyKey }).expect(202);
    const conflict = await postJob({ idempotencyKey, input: "Outro texto bem diferente do primeiro" }).expect(409);
    expect(ApiErrorSchema.parse(conflict.body).error).toMatch(/idempotência/);

    const missing = await postJob({ idempotencyKey: randomUUID(), targetColumnId: randomUUID() }).expect(404);
    expect(ApiErrorSchema.parse(missing.body).error).toBe("Coluna de destino não encontrada");

    await postJob({ idempotencyKey: randomUUID(), input: "curto" }).expect(400);
    await request(app).get("/api/ai/jobs/nao-uuid").expect(400);
    await request(app).get(`/api/ai/jobs/${randomUUID()}`).expect(404);
  });

  it("com o broker fora, o job continua pendente; quando volta, é publicado e vira 'queued'", async () => {
    const job = AiJobSchema.parse((await postJob({ idempotencyKey: randomUUID() }).expect(202)).body);

    const down = await publishPendingJobs(() => Promise.reject(new Error("RabbitMQ indisponível")), 100);
    expect(down.published).toEqual([]);
    expect(down.error).toBeInstanceOf(Error);
    expect((await jobRow(job.id))?.status).toBe("pending_publish");

    const sent: GenerateCardsCommand[] = [];
    const up = await publishPendingJobs(async (command) => { sent.push(command); }, 100);
    expect(up.error).toBeNull();
    const command = sent.find((item) => item.jobId === job.id);
    expect(GenerateCardsCommandSchema.parse(command).payload).toMatchObject({
      targetColumnId: columnId, input: job.input, maxCards: 8, locale: "pt-BR",
    });
    expect((await jobRow(job.id))?.status).toBe("queued");
  });

  it("se o broker cai no meio do lote, marca só os confirmados", async () => {
    const jobs = [];
    for (let index = 0; index < 3; index += 1) {
      jobs.push(AiJobSchema.parse((await postJob({ idempotencyKey: randomUUID() }).expect(202)).body));
    }
    let calls = 0;
    const result = await publishPendingJobs(async () => {
      calls += 1;
      if (calls === 2) throw new Error("conexão perdida");
    }, 100);
    expect(result.published).toHaveLength(1);
    const statuses = await Promise.all(jobs.map(async (job) => (await jobRow(job.id))?.status));
    expect(statuses.filter((status) => status === "queued")).toHaveLength(1);
    expect(statuses.filter((status) => status === "pending_publish")).toHaveLength(2);
    await publishPendingJobs(async () => undefined, 100);
  });

  it("aplica os eventos do worker sem duplicar cartões nem regredir o status", async () => {
    const job = AiJobSchema.parse((await postJob({ idempotencyKey: randomUUID(), maxCards: 2 }, "req-eventos").expect(202)).body);
    const base = { jobId: job.id, correlationId: "req-eventos" } as const;

    expect(await applyAiJobEvent({
      schemaVersion: 1, type: "cards.generation_started", messageId: randomUUID(), createdAt: new Date().toISOString(),
      worker: "worker-teste", ...base,
    })).toBe("applied");
    expect(await jobRow(job.id)).toMatchObject({ status: "processing", worker: "worker-teste" });

    // O worker devolveu 3 cartões, mas o job pediu no máximo 2.
    const event = generatedEvent(base, ["Primeiro", "Segundo", "Terceiro"]);
    expect(await applyAiJobEvent(event)).toBe("applied");
    expect(await applyAiJobEvent(event)).toBe("ignored");

    const done = AiJobSchema.parse((await request(app).get(`/api/ai/jobs/${job.id}`).expect(200)).body);
    expect(done).toMatchObject({ status: "succeeded", provider: "ollama", model: "qwen3:1.7b", error: null });
    expect(done.cardIds).toHaveLength(2);
    expect(done.completedAt).not.toBeNull();

    const cards = await query<{ title: string; position: number }>(
      "select title, position from cards where id = any($1::uuid[]) order by position", [done.cardIds]);
    expect(cards.rows).toEqual([
      { title: "Primeiro", position: 2048 + 1024 },
      { title: "Segundo", position: 2048 + 2048 },
    ]);

    expect(await applyAiJobEvent({
      schemaVersion: 1, type: "cards.generation_failed", messageId: randomUUID(), createdAt: new Date().toISOString(),
      worker: "worker-atrasado", provider: null, model: null, ...base,
      payload: { code: "timeout", message: "atrasado" },
    })).toBe("ignored");
    expect((await jobRow(job.id))?.status).toBe("succeeded");
  });

  it("registra a falha do worker e a exclusão da coluna antes do resultado", async () => {
    const failed = AiJobSchema.parse((await postJob({ idempotencyKey: randomUUID() }).expect(202)).body);
    await applyAiJobEvent({
      schemaVersion: 1, type: "cards.generation_failed", messageId: randomUUID(), createdAt: new Date().toISOString(),
      jobId: failed.id, correlationId: "x", worker: "worker-teste", provider: "openrouter", model: "m",
      payload: { code: "unauthorized", message: "Token do OpenRouter inválido" },
    });
    expect(await jobRow(failed.id)).toMatchObject({ status: "failed", error: "Token do OpenRouter inválido" });

    const doomedColumn = await createColumn("Será excluída");
    const orphan = AiJobSchema.parse((await postJob({ idempotencyKey: randomUUID(), targetColumnId: doomedColumn }).expect(202)).body);
    await query("delete from columns where id = $1", [doomedColumn]);
    expect(await applyAiJobEvent(generatedEvent({ jobId: orphan.id, correlationId: "x" }, ["Perdido"]))).toBe("applied");
    expect(await jobRow(orphan.id)).toMatchObject({
      status: "failed", error: "A coluna de destino foi excluída antes de os cartões ficarem prontos.",
    });
  });
});

describe.skipIf(!process.env.DATABASE_URL || !process.env.RABBITMQ_URL)("Fluxo completo com RabbitMQ real", () => {
  let broker: Broker;
  let outbox: Outbox;
  let workerConnection: ChannelModel;
  let workerChannel: Channel;
  let workerTag: string | null = null;
  let columnId: string;
  const processedBy: string[] = [];

  const app = createApp({ onAiJobCreated: () => void outbox.trigger() });

  /** Worker falso: faz o papel do Serviço B só pelo broker. */
  async function startFakeWorker(): Promise<void> {
    const reply = await workerChannel.consume(AI_MESSAGING.queues.generate, (message) => {
      if (!message) return;
      const command = GenerateCardsCommandSchema.parse(JSON.parse(message.content.toString("utf8")));
      processedBy.push(command.jobId);
      const publish = (event: AiJobEvent) => workerChannel.publish(
        AI_MESSAGING.exchanges.events, event.type, Buffer.from(JSON.stringify(event)), { persistent: true });
      publish({
        schemaVersion: 1, type: "cards.generation_started", messageId: randomUUID(), jobId: command.jobId,
        correlationId: command.correlationId, createdAt: new Date().toISOString(), worker: "worker-falso",
      });
      publish(generatedEvent(command, [`Cartão de ${command.payload.input.slice(0, 20)}`]));
      workerChannel.ack(message);
    });
    workerTag = reply.consumerTag;
  }

  async function waitForJob(id: string, status: AiJob["status"]): Promise<AiJob> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const job = AiJobSchema.parse((await request(app).get(`/api/ai/jobs/${id}`).expect(200)).body);
      if (job.status === status) return job;
      if (Date.now() > deadline) throw new Error(`Job ${id} ficou em ${job.status}, esperado ${status}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  beforeAll(async () => {
    const url = process.env.RABBITMQ_URL ?? "";
    columnId = await createColumn("Fluxo completo");
    broker = await connectBroker(url, startResultsConsumer);
    outbox = createOutbox((command) => broker.publish(
      AI_MESSAGING.exchanges.commands, AI_MESSAGING.routingKeys.generate, command,
      { messageId: command.messageId, correlationId: command.correlationId, type: command.type }));
    workerConnection = await connect(url);
    workerChannel = await workerConnection.createChannel();
    await assertAiTopology(workerChannel);
    await workerChannel.purgeQueue(AI_MESSAGING.queues.generate);
    outbox.start();
  });

  afterAll(async () => {
    await outbox.stop();
    await workerConnection.close();
    await broker.close();
  });

  function postJob(input: string) {
    return request(app).post("/api/ai/jobs").set("X-Request-Id", `req-${input.length}`)
      .send({ input, targetColumnId: columnId, idempotencyKey: randomUUID() }).expect(202)
      .then((response) => AiJobSchema.parse(response.body));
  }

  it("A publica, B consome pelo broker e A grava os cartões", async () => {
    await startFakeWorker();
    const job = await postJob("Planejamento: subir o projeto no Kubernetes");
    const done = await waitForJob(job.id, "succeeded");
    expect(done.cardIds).toHaveLength(1);
    expect(processedBy).toContain(job.id);
  });

  it("com o worker parado, os pedidos esperam na fila e são processados quando ele volta", async () => {
    if (workerTag) await workerChannel.cancel(workerTag);
    const jobs = [await postJob("Pedido feito com o worker parado 1"), await postJob("Pedido feito com o worker parado 2")];
    await Promise.all(jobs.map((job) => waitForJob(job.id, "queued")));
    const queue = await workerChannel.checkQueue(AI_MESSAGING.queues.generate);
    expect(queue.messageCount).toBe(2);

    await startFakeWorker();
    for (const job of jobs) await waitForJob(job.id, "succeeded");
    expect((await workerChannel.checkQueue(AI_MESSAGING.queues.generate)).messageCount).toBe(0);
  });
});
