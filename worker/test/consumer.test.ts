import { randomUUID } from "node:crypto";
import { AiJobEventSchema, type AiJobEvent, type GeneratedCard } from "@taskflow/shared";
import { describe, expect, it } from "vitest";
import { attemptOf, MAX_ATTEMPTS, processCommand, type ProcessDeps } from "../src/consumer.ts";
import { LlmError } from "../src/llm/client.ts";

const command = {
  schemaVersion: 1,
  type: "cards.generate",
  messageId: randomUUID(),
  jobId: randomUUID(),
  correlationId: "req-worker",
  createdAt: new Date().toISOString(),
  payload: {
    boardId: randomUUID(), targetColumnId: randomUUID(), input: "Como aluno, quero gerar cartões",
    maxCards: 4, locale: "pt-BR", promptVersion: "v1",
  },
};
const content = Buffer.from(JSON.stringify(command));

function deps(generate: () => Promise<GeneratedCard[]>, publishFails = false) {
  const events: AiJobEvent[] = [];
  const value: ProcessDeps = {
    llm: { generateCards: generate },
    publishEvent: async (event) => {
      if (publishFails) throw new Error("canal fechado");
      events.push(AiJobEventSchema.parse(event));
    },
    worker: "worker-1",
    provider: "ollama",
    model: "qwen3:1.7b",
  };
  return { events, value };
}

describe("Processamento de um comando cards.generate", () => {
  it("publica início e resultado, e confirma a mensagem", async () => {
    const { events, value } = deps(async () => [{ title: "Criar fila", description: null }]);
    expect(await processCommand(content, 1, value)).toEqual({ action: "ack" });
    expect(events.map((event) => event.type)).toEqual(["cards.generation_started", "cards.generated"]);
    expect(events[1]).toMatchObject({
      jobId: command.jobId, correlationId: "req-worker", worker: "worker-1", provider: "ollama",
      payload: { cards: [{ title: "Criar fila", description: null }] },
    });
  });

  it("devolve à fila uma falha passageira enquanto houver tentativas", async () => {
    const { events, value } = deps(async () => {
      throw new LlmError("timeout", "O modelo não respondeu", true);
    });
    expect(await processCommand(content, 1, value)).toEqual({ action: "retry", reason: "O modelo não respondeu" });
    expect(events.map((event) => event.type)).toEqual(["cards.generation_started"]);
  });

  it("na última tentativa, publica a falha e manda a mensagem para a DLQ", async () => {
    const { events, value } = deps(async () => {
      throw new LlmError("llm_unavailable", "Ollama fora do ar", true);
    });
    const decision = await processCommand(content, MAX_ATTEMPTS, value);
    expect(decision.action).toBe("reject");
    expect(events.at(-1)).toMatchObject({
      type: "cards.generation_failed",
      payload: { code: "llm_unavailable", message: "Ollama fora do ar (desistindo após 3 tentativas)" },
    });
  });

  it("falha definitiva (credencial, formato) vira evento de falha e confirma sem repetir", async () => {
    const { events, value } = deps(async () => {
      throw new LlmError("unauthorized", "Token recusado", false);
    });
    expect(await processCommand(content, 1, value)).toEqual({ action: "ack" });
    expect(events.at(-1)).toMatchObject({ type: "cards.generation_failed", payload: { code: "unauthorized" } });
  });

  it("devolve à fila se não conseguir publicar no broker", async () => {
    const { value } = deps(async () => [{ title: "A", description: null }], true);
    expect(await processCommand(content, 1, value)).toEqual({ action: "retry", reason: "canal fechado" });
  });

  it("rejeita mensagem fora do contrato sem chamar o modelo", async () => {
    let called = false;
    const { events, value } = deps(async () => {
      called = true;
      return [];
    });
    expect((await processCommand(Buffer.from("{}"), 1, value)).action).toBe("reject");
    expect((await processCommand(Buffer.from("não é json"), 1, value)).action).toBe("reject");
    expect(called).toBe(false);
    expect(events).toEqual([]);
  });
});

describe("Número da tentativa", () => {
  it("vem do x-delivery-count das filas quorum", () => {
    expect(attemptOf(undefined)).toBe(1);
    expect(attemptOf({})).toBe(1);
    expect(attemptOf({ "x-delivery-count": 2 })).toBe(3);
    expect(attemptOf({ "x-delivery-count": "2" })).toBe(1);
  });
});
