import { randomUUID } from "node:crypto";
import {
  GenerateCardsCommandSchema,
  type AiJobEvent,
  type GenerateCardsCommand,
  type LlmProvider,
} from "@taskflow/shared";
import { LlmError, type LlmClient } from "./llm/client.ts";
import { errorMessage, log } from "./log.ts";

/** Tentativas por mensagem antes de desistir (abaixo do x-delivery-limit da fila). */
export const MAX_ATTEMPTS = 3;

export interface ProcessDeps {
  llm: LlmClient;
  publishEvent(event: AiJobEvent): Promise<void>;
  worker: string;
  provider: LlmProvider;
  model: string;
}

export type Decision =
  | { action: "ack" }
  | { action: "retry"; reason: string }
  | { action: "reject"; reason: string };

function eventBase(command: GenerateCardsCommand, worker: string) {
  return {
    schemaVersion: 1 as const,
    messageId: randomUUID(),
    jobId: command.jobId,
    correlationId: command.correlationId,
    createdAt: new Date().toISOString(),
    worker,
  };
}

function parseCommand(content: Buffer): GenerateCardsCommand | null {
  try {
    const parsed = GenerateCardsCommandSchema.safeParse(JSON.parse(content.toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Processa um comando cards.generate e decide o destino da mensagem:
 * - ack: resultado (sucesso ou falha definitiva) publicado e confirmado pelo broker;
 * - retry: falha passageira (modelo fora, timeout); volta para a fila;
 * - reject: mensagem inválida ou tentativas esgotadas; vai para a DLQ.
 */
export async function processCommand(content: Buffer, attempt: number, deps: ProcessDeps): Promise<Decision> {
  const command = parseCommand(content);
  if (!command) return { action: "reject", reason: "Comando fora do contrato" };

  const context = { correlationId: command.correlationId, jobId: command.jobId, attempt };
  log("msg.consumed", context);
  const startedAt = Date.now();

  try {
    await deps.publishEvent({ ...eventBase(command, deps.worker), type: "cards.generation_started" });
    const cards = await deps.llm.generateCards(command.payload.input, command.payload.maxCards);
    const durationMs = Date.now() - startedAt;
    log("llm.done", { ...context, provider: deps.provider, model: deps.model, durationMs, cards: cards.length });
    await deps.publishEvent({
      ...eventBase(command, deps.worker),
      type: "cards.generated",
      provider: deps.provider,
      model: deps.model,
      durationMs,
      payload: { cards },
    });
    log("result.published", { ...context, type: "cards.generated" });
    return { action: "ack" };
  } catch (error: unknown) {
    if (!(error instanceof LlmError)) {
      // Falha ao falar com o broker: a mensagem volta para a fila.
      return { action: "retry", reason: errorMessage(error) };
    }
    log("llm.failed", { ...context, code: error.code, retryable: error.retryable, error: error.message });
    if (error.retryable && attempt < MAX_ATTEMPTS) return { action: "retry", reason: error.message };

    const message = error.retryable
      ? `${error.message} (desistindo após ${attempt} tentativas)`
      : error.message;
    try {
      await deps.publishEvent({
        ...eventBase(command, deps.worker),
        type: "cards.generation_failed",
        provider: deps.provider,
        model: deps.model,
        payload: { code: error.code, message },
      });
    } catch (publishError: unknown) {
      return { action: "retry", reason: errorMessage(publishError) };
    }
    log("result.published", { ...context, type: "cards.generation_failed", code: error.code });
    // Tentativas esgotadas vão para a DLQ como evidência; erro definitivo só confirma.
    return error.retryable ? { action: "reject", reason: message } : { action: "ack" };
  }
}

/** Número da tentativa atual, a partir do contador das filas quorum. */
export function attemptOf(headers: Record<string, unknown> | undefined): number {
  const count = headers?.["x-delivery-count"];
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count + 1 : 1;
}
