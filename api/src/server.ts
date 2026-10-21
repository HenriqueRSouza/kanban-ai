import type { GenerateCardsCommand } from "@taskflow/shared";
import { AI_MESSAGING } from "@taskflow/shared";
import { createApp } from "./app.ts";
import { pool } from "./db.ts";
import { errorMessage, log } from "./log.ts";
import { connectBroker, type Broker } from "./messaging/broker.ts";
import { createOutbox } from "./messaging/outbox.ts";
import { startResultsConsumer } from "./messaging/results.ts";

const port = Number(process.env.PORT ?? 3000);
const rabbitmqUrl = process.env.RABBITMQ_URL;

let broker: Broker | null = null;
const outbox = createOutbox((command: GenerateCardsCommand) => {
  if (!broker) return Promise.reject(new Error("RabbitMQ não configurado"));
  return broker.publish(AI_MESSAGING.exchanges.commands, AI_MESSAGING.routingKeys.generate, command, {
    messageId: command.messageId,
    correlationId: command.correlationId,
    type: command.type,
  });
});

const server = createApp({ onAiJobCreated: () => void outbox.trigger() }).listen(port, () => {
  console.log(`API disponível na porta ${port}`);
});

if (rabbitmqUrl) {
  broker = await connectBroker(rabbitmqUrl, startResultsConsumer);
  outbox.start();
} else {
  log("broker.disabled", { reason: "RABBITMQ_URL não definida; jobs do Agente de IA ficam pendentes" });
}

// Encerramento limpo (docker stop / Kubernetes): para de aceitar requisições,
// termina a varredura em andamento e fecha broker e banco.
async function shutdown(signal: string): Promise<void> {
  log("shutdown", { signal });
  server.close();
  await outbox.stop();
  await broker?.close().catch((error: unknown) => log("broker.close_failed", { error: errorMessage(error) }));
  await pool.end();
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
