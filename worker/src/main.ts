import { createServer } from "node:http";
import { AI_MESSAGING, assertAiTopology, type AiJobEvent } from "@taskflow/shared";
import { connect, type ChannelModel, type ConfirmChannel, type ConsumeMessage } from "amqplib";
import { ConfigError, loadConfig } from "./config.ts";
import { ATTEMPT_HEADER, attemptOf, processCommand, type Decision } from "./consumer.ts";
import { createLlmClient } from "./llm/client.ts";
import { errorMessage, log } from "./log.ts";

const RETRY_DELAY_MS = 5000;
const SHUTDOWN_TIMEOUT_MS = 30_000;

let config;
try {
  config = loadConfig();
} catch (error: unknown) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exit(1);
}
const { llm: llmConfig, workerName } = config;
const llm = createLlmClient(llmConfig);

let connected = false;
let channel: ConfirmChannel | null = null;
let consumerTag: string | null = null;
let inFlight: Promise<void> | null = null;

function publishEvent(target: ConfirmChannel, event: AiJobEvent): Promise<void> {
  return new Promise((resolve, reject) => {
    target.publish(AI_MESSAGING.exchanges.events, event.type, Buffer.from(JSON.stringify(event)), {
      persistent: true,
      contentType: "application/json",
      messageId: event.messageId,
      correlationId: event.correlationId,
      type: event.type,
    }, (error: unknown) => (error ? reject(new Error(errorMessage(error))) : resolve()));
  });
}

/**
 * Nova tentativa: publica uma cópia no fim da fila com o número da próxima
 * tentativa e, só depois da confirmação do broker, dá ack na original. Se o
 * worker cair entre os dois passos, a original volta (sem ack) e o job pode ser
 * processado de novo; a API aplica o resultado de forma idempotente pelo jobId.
 */
function republishForRetry(target: ConfirmChannel, message: ConsumeMessage, nextAttempt: number): Promise<void> {
  const { headers, ...properties } = message.properties;
  const { "x-delivery-count": _ignored, ...rest } = headers ?? {};
  return new Promise((resolve, reject) => {
    target.sendToQueue(AI_MESSAGING.queues.generate, message.content, {
      persistent: true,
      contentType: properties.contentType,
      messageId: properties.messageId,
      correlationId: properties.correlationId,
      type: properties.type,
      timestamp: properties.timestamp,
      headers: { ...rest, [ATTEMPT_HEADER]: nextAttempt },
    }, (error: unknown) => (error ? reject(new Error(errorMessage(error))) : resolve()));
  });
}

function settle(target: ConfirmChannel, message: ConsumeMessage, decision: Decision): void {
  // Se o canal caiu, o RabbitMQ devolve a mensagem sem ack à fila sozinho.
  try {
    if (decision.action === "ack") target.ack(message);
    else target.nack(message, false, decision.action === "retry");
  } catch (error: unknown) {
    log("msg.settle_failed", { error: errorMessage(error) });
  }
}

async function handle(target: ConfirmChannel, message: ConsumeMessage): Promise<void> {
  const attempt = attemptOf(message.properties.headers);
  const decision = await processCommand(message.content, attempt, {
    llm,
    publishEvent: (event) => publishEvent(target, event),
    worker: workerName,
    provider: llmConfig.provider,
    model: llmConfig.model,
  });
  if (decision.action !== "ack") log(`msg.${decision.action}`, { reason: decision.reason });
  // Espera antes de devolver, para um modelo fora do ar não virar um laço de reentregas.
  if (decision.action === "retry") {
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    try {
      await republishForRetry(target, message, attempt + 1);
      target.ack(message);
      return;
    } catch (error: unknown) {
      // Sem a cópia confirmada, devolve a original à fila (comportamento anterior).
      log("msg.republish_failed", { error: errorMessage(error) });
    }
  }
  settle(target, message, decision);
}

const connection = await connect(config.rabbitmqUrl, {
  // Sem timeout, uma reconexão que pega o broker ainda desligando fica pendurada
  // para sempre e o worker para de consumir (mesmo problema da API).
  timeout: 10_000,
  recovery: {
    waitForConnect: false,
    maxDelay: 10_000,
    async setup(model: ChannelModel) {
      const target = await model.createConfirmChannel();
      target.on("error", (error: Error) => log("broker.channel_error", { error: error.message }));
      await assertAiTopology(target);
      // Uma inferência por vez: com várias réplicas, cada uma pega a próxima mensagem livre.
      await target.prefetch(1);
      const reply = await target.consume(AI_MESSAGING.queues.generate, (message) => {
        if (!message) return;
        inFlight = handle(target, message).finally(() => {
          inFlight = null;
        });
      }, { noAck: false });
      channel = target;
      consumerTag = reply.consumerTag;
    },
  },
});
connection.on("connect", () => {
  connected = true;
  log("broker.connected", { provider: llmConfig.provider, model: llmConfig.model, baseUrl: llmConfig.baseUrl });
});
connection.on("disconnect", (error: Error) => {
  connected = false;
  channel = null;
  consumerTag = null;
  log("broker.disconnected", { error: error.message });
});
connection.on("error", (error: Error) => log("broker.error", { error: error.message }));

// Usado pelas probes do Kubernetes; não é exposto fora da rede interna.
const health = createServer((req, res) => {
  const ok = req.url === "/healthz" && connected;
  res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: ok ? "ok" : "unavailable", connected, busy: inFlight !== null }));
});
health.listen(config.healthPort, () => log("worker.started", { worker: workerName, healthPort: config.healthPort }));

// Encerramento limpo (docker stop / HPA reduzindo réplicas): para de receber
// mensagens, termina a inferência em andamento e só então fecha a conexão.
async function shutdown(signal: string): Promise<void> {
  log("shutdown", { signal, busy: inFlight !== null });
  if (channel && consumerTag) await channel.cancel(consumerTag).catch(() => undefined);
  const timeout = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS));
  await Promise.race([inFlight, timeout]);
  health.close();
  await connection.close().catch(() => undefined);
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
