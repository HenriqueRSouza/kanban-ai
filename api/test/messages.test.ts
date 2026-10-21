import { randomUUID } from "node:crypto";
import {
  AI_MESSAGING,
  AiJobEventSchema,
  CreateAiJobSchema,
  GenerateCardsCommandSchema,
  assertAiTopology,
  type TopologyChannel,
} from "@taskflow/shared";
import { describe, expect, it } from "vitest";
import { handleResultMessage } from "../src/messaging/results.ts";
import { uuidV5 } from "../src/uuid.ts";

const envelope = () => ({
  schemaVersion: 1,
  messageId: randomUUID(),
  jobId: randomUUID(),
  correlationId: "req-123",
  createdAt: "2026-10-21T12:00:00.000Z",
});

describe("Contrato do pedido HTTP", () => {
  const valid = { input: "Como usuário, quero filtrar cartões", targetColumnId: randomUUID(), idempotencyKey: randomUUID() };

  it("aplica o padrão de 8 cartões e remove espaços do texto", () => {
    expect(CreateAiJobSchema.parse({ ...valid, input: `  ${valid.input}  ` })).toEqual({ ...valid, maxCards: 8 });
  });

  it("rejeita texto curto ou longo demais, maxCards fora do limite e chave que não é UUID", () => {
    expect(CreateAiJobSchema.safeParse({ ...valid, input: "curto" }).success).toBe(false);
    expect(CreateAiJobSchema.safeParse({ ...valid, input: "x".repeat(8001) }).success).toBe(false);
    expect(CreateAiJobSchema.safeParse({ ...valid, maxCards: 0 }).success).toBe(false);
    expect(CreateAiJobSchema.safeParse({ ...valid, maxCards: 21 }).success).toBe(false);
    expect(CreateAiJobSchema.safeParse({ ...valid, idempotencyKey: "abc" }).success).toBe(false);
  });
});

describe("Contrato das mensagens do RabbitMQ", () => {
  it("aceita um comando válido e recusa versão ou locale desconhecidos", () => {
    const command = {
      ...envelope(),
      type: "cards.generate",
      payload: {
        boardId: randomUUID(), targetColumnId: randomUUID(), input: "Planejamento do projeto de nuvem",
        maxCards: 5, locale: "pt-BR", promptVersion: "v1",
      },
    };
    expect(GenerateCardsCommandSchema.safeParse(command).success).toBe(true);
    expect(GenerateCardsCommandSchema.safeParse({ ...command, schemaVersion: 2 }).success).toBe(false);
    expect(GenerateCardsCommandSchema.safeParse({ ...command, payload: { ...command.payload, locale: "en" } }).success).toBe(false);
  });

  it("valida os três eventos do worker", () => {
    const generated = {
      ...envelope(), type: "cards.generated", worker: "worker-1", provider: "ollama", model: "qwen3:1.7b",
      durationMs: 1200, payload: { cards: [{ title: "Criar fila", description: null }] },
    };
    expect(AiJobEventSchema.safeParse({ ...envelope(), type: "cards.generation_started", worker: "worker-1" }).success).toBe(true);
    expect(AiJobEventSchema.safeParse(generated).success).toBe(true);
    expect(AiJobEventSchema.safeParse({
      ...envelope(), type: "cards.generation_failed", worker: "worker-1", provider: null, model: null,
      payload: { code: "timeout", message: "O modelo demorou demais" },
    }).success).toBe(true);
  });

  it("recusa resultado sem cartões, com título vazio ou com provedor desconhecido", () => {
    const base = {
      ...envelope(), type: "cards.generated", worker: "worker-1", provider: "ollama", model: "m", durationMs: 1,
    };
    expect(AiJobEventSchema.safeParse({ ...base, payload: { cards: [] } }).success).toBe(false);
    expect(AiJobEventSchema.safeParse({ ...base, payload: { cards: [{ title: "  ", description: null }] } }).success).toBe(false);
    expect(AiJobEventSchema.safeParse({
      ...base, provider: "gpt", payload: { cards: [{ title: "Ok", description: null }] },
    }).success).toBe(false);
  });
});

describe("Topologia do broker", () => {
  it("declara exchanges, filas quorum com DLQ e as ligações", async () => {
    const calls: string[] = [];
    const queues = new Map<string, Record<string, string | number>>();
    const channel: TopologyChannel = {
      assertExchange: async (name) => calls.push(`exchange ${name}`),
      assertQueue: async (name, options) => {
        queues.set(name, options.arguments);
        return calls.push(`queue ${name}`);
      },
      bindQueue: async (queue, exchange, key) => calls.push(`bind ${queue} <- ${exchange}:${key}`),
    };
    await assertAiTopology(channel);

    expect(queues.get(AI_MESSAGING.queues.generate)).toEqual({
      "x-queue-type": "quorum",
      "x-delivery-limit": 3,
      "x-dead-letter-exchange": "taskflow.dlx",
      "x-dead-letter-routing-key": "ai.generate.dlq",
    });
    expect(queues.get(AI_MESSAGING.queues.resultsDeadLetter)).toEqual({ "x-queue-type": "quorum" });
    expect(calls).toContain("bind ai.generate <- taskflow.commands:cards.generate");
    expect(calls).toContain("bind ai.results <- taskflow.events:cards.generated");
    expect(calls).toContain("bind ai.generate.dlq <- taskflow.dlx:ai.generate.dlq");
  });
});

describe("Resultados inválidos", () => {
  it("vão direto para a DLQ, sem tocar no banco", async () => {
    expect(await handleResultMessage(Buffer.from("{nao é json"))).toEqual({ action: "reject", reason: "JSON inválido" });
    const outOfContract = await handleResultMessage(Buffer.from(JSON.stringify({ type: "cards.generated" })));
    expect(outOfContract.action).toBe("reject");
  });
});

describe("UUID v5", () => {
  it("segue o vetor de teste da RFC e é determinístico", () => {
    const dns = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    expect(uuidV5("www.example.com", dns)).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
    expect(uuidV5("job:0", dns)).toBe(uuidV5("job:0", dns));
    expect(uuidV5("job:0", dns)).not.toBe(uuidV5("job:1", dns));
  });
});
