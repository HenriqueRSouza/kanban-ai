import { assertAiTopology } from "@taskflow/shared";
import { connect, type ChannelModel, type ConfirmChannel } from "amqplib";
import { errorMessage, log } from "../log.ts";

export interface PublishOptions {
  messageId: string;
  correlationId: string;
  type: string;
}

export interface Broker {
  /** Publica JSON persistente e só resolve depois da confirmação do RabbitMQ. */
  publish(exchange: string, routingKey: string, body: unknown, options: PublishOptions): Promise<void>;
  close(): Promise<void>;
}

const CONFIRM_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Conecta ao RabbitMQ com reconexão automática. A API sobe mesmo com o broker
 * fora do ar: os jobs ficam em 'pending_publish' até a conexão voltar.
 * `onConnected` roda a cada (re)conexão, para recriar os consumidores.
 */
export async function connectBroker(
  url: string,
  onConnected: (model: ChannelModel) => Promise<void>,
): Promise<Broker> {
  let connected = false;
  let publisher: Promise<ConfirmChannel> | null = null;

  const connection = await connect(url, {
    // Sem timeout, uma reconexão que pega o broker ainda desligando (TCP aceito,
    // handshake AMQP sem resposta) fica pendurada para sempre e a API nunca
    // mais publica. Com ele, a tentativa falha e a próxima é agendada.
    timeout: CONNECT_TIMEOUT_MS,
    recovery: {
      waitForConnect: false,
      maxDelay: 10_000,
      async setup(model: ChannelModel) {
        const channel = await model.createChannel();
        await assertAiTopology(channel);
        await channel.close();
        await onConnected(model);
      },
    },
  });
  connection.on("connect", () => {
    connected = true;
    log("broker.connected");
  });
  connection.on("disconnect", (error: Error) => {
    connected = false;
    publisher = null;
    log("broker.disconnected", { error: error.message });
  });
  connection.on("reconnect-scheduled", ({ attempt, delay }: { attempt: number; delay: number }) => {
    log("broker.reconnect_scheduled", { attempt, delayMs: delay });
  });
  connection.on("error", (error: Error) => log("broker.error", { error: error.message }));

  function getPublisher(): Promise<ConfirmChannel> {
    // Sem conexão, falha na hora: o outbox tenta de novo depois, em vez de travar esperando.
    if (!connected) return Promise.reject(new Error("RabbitMQ indisponível"));
    publisher ??= connection.createConfirmChannel().then((channel) => {
      channel.on("close", () => {
        publisher = null;
      });
      channel.on("error", (error: Error) => log("broker.publisher_error", { error: error.message }));
      return channel;
    }, (error: unknown) => {
      publisher = null;
      throw error;
    });
    return publisher;
  }

  return {
    async publish(exchange, routingKey, body, options) {
      const channel = await getPublisher();
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("RabbitMQ não confirmou a publicação a tempo")), CONFIRM_TIMEOUT_MS);
        channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(body)), {
          persistent: true,
          contentType: "application/json",
          messageId: options.messageId,
          correlationId: options.correlationId,
          type: options.type,
          timestamp: Math.floor(Date.now() / 1000),
        }, (error: unknown) => {
          clearTimeout(timeout);
          if (error) reject(error instanceof Error ? error : new Error(errorMessage(error)));
          else resolve();
        });
      });
    },
    async close() {
      await connection.close();
    },
  };
}
