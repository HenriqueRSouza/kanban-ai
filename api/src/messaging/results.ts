import { AI_MESSAGING, AiJobEventSchema, GenerateCardsCommandSchema } from "@taskflow/shared";
import type { Channel, ChannelModel, ConsumeMessage } from "amqplib";
import { applyAiJobEvent, failDeadLetteredJob, type ApplyOutcome } from "../ai-jobs.ts";
import { errorMessage, log } from "../log.ts";

const PREFETCH = 10;
// Espera antes de devolver à fila após falha no banco: com o limite de 3
// entregas, devolver na hora mandaria o resultado à DLQ em milissegundos.
const RETRY_DELAY_MS = 5000;

export type ResultDecision =
  | { action: "ack"; outcome: ApplyOutcome }
  | { action: "reject"; reason: string }
  | { action: "retry"; reason: string };

/** Decide o destino de uma mensagem de resultado. Separado do canal para ser testável. */
export async function handleResultMessage(content: Buffer): Promise<ResultDecision> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch {
    return { action: "reject", reason: "JSON inválido" };
  }
  const event = AiJobEventSchema.safeParse(parsed);
  if (!event.success) {
    return { action: "reject", reason: event.error.issues[0]?.message ?? "Mensagem fora do contrato" };
  }
  try {
    const outcome = await applyAiJobEvent(event.data);
    log("result.consumed", {
      correlationId: event.data.correlationId,
      jobId: event.data.jobId,
      type: event.data.type,
      worker: event.data.worker,
      outcome,
    });
    return { action: "ack", outcome };
  } catch (error: unknown) {
    return { action: "retry", reason: errorMessage(error) };
  }
}

function settle(channel: Channel, message: ConsumeMessage, decision: ResultDecision): void {
  // Se o canal caiu nesse meio-tempo, o RabbitMQ reentrega a mensagem sozinho.
  try {
    if (decision.action === "ack") channel.ack(message);
    // requeue=false manda para a DLQ (x-dead-letter-exchange da fila).
    else channel.nack(message, false, decision.action === "retry");
  } catch (error: unknown) {
    log("result.settle_failed", { error: errorMessage(error) });
  }
}

/** Consome a fila ai.results. Recriado pelo broker a cada reconexão. */
export async function startResultsConsumer(model: ChannelModel): Promise<void> {
  const channel = await model.createChannel();
  channel.on("error", (error: Error) => log("result.channel_error", { error: error.message }));
  await channel.prefetch(PREFETCH);
  await channel.consume(AI_MESSAGING.queues.results, (message) => {
    if (!message) return;
    void handleResultMessage(message.content).then((decision) => {
      if (decision.action === "ack") {
        settle(channel, message, decision);
        return;
      }
      log(decision.action === "reject" ? "result.rejected" : "result.retry", {
        reason: decision.reason,
        messageId: typeof message.properties.messageId === "string" ? message.properties.messageId : null,
      });
      if (decision.action === "reject") settle(channel, message, decision);
      else setTimeout(() => settle(channel, message, decision), RETRY_DELAY_MS);
    });
  }, { noAck: false });
}

export const DEAD_LETTER_REASON =
  "O pedido não pôde ser processado: o Serviço B falhou em todas as tentativas. Tente de novo.";

export type DeadLetterDecision =
  | { action: "ack"; jobId: string | null; failed: boolean }
  | { action: "retry"; reason: string };

/**
 * Decide o destino de um comando que caiu na ai.generate.dlq. Comando ilegível
 * é só descartado (fica no log); comando válido marca o job como falho, para o
 * usuário não ver "Processando" para sempre.
 */
export async function handleDeadLetteredCommand(content: Buffer): Promise<DeadLetterDecision> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf8"));
  } catch {
    return { action: "ack", jobId: null, failed: false };
  }
  const command = GenerateCardsCommandSchema.safeParse(parsed);
  if (!command.success) return { action: "ack", jobId: null, failed: false };
  try {
    const failed = await failDeadLetteredJob(command.data.jobId, DEAD_LETTER_REASON);
    log("job.dead_lettered", { correlationId: command.data.correlationId, jobId: command.data.jobId, failed });
    return { action: "ack", jobId: command.data.jobId, failed };
  } catch (error: unknown) {
    return { action: "retry", reason: errorMessage(error) };
  }
}

/** Consome a ai.generate.dlq. Recriado pelo broker a cada reconexão. */
export async function startDeadLetterConsumer(model: ChannelModel): Promise<void> {
  const channel = await model.createChannel();
  channel.on("error", (error: Error) => log("dlq.channel_error", { error: error.message }));
  await channel.prefetch(PREFETCH);
  await channel.consume(AI_MESSAGING.queues.generateDeadLetter, (message) => {
    if (!message) return;
    void handleDeadLetteredCommand(message.content).then((decision) => {
      try {
        if (decision.action === "ack") channel.ack(message);
        // A DLQ não tem DLQ: falha no banco volta para a fila depois de uma pausa.
        else setTimeout(() => channel.nack(message, false, true), RETRY_DELAY_MS);
      } catch (error: unknown) {
        log("dlq.settle_failed", { error: errorMessage(error) });
      }
    });
  }, { noAck: false });
}
