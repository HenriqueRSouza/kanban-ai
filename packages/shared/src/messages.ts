import { z } from "zod";
import { BoardIdSchema, CardIdSchema, CardSchema, ColumnIdSchema } from "./schemas.ts";

/*
 * Contratos do "Agente de IA": jobs expostos pela API (Serviço A) e mensagens
 * trocadas pelo RabbitMQ entre o Serviço A e o worker (Serviço B).
 * Os dois serviços só conhecem o broker e estes schemas, nunca o endereço um
 * do outro.
 */

export const AiJobIdSchema = z.uuid().brand<"AiJobId">();

export const AI_INPUT_LIMITS = { min: 10, max: 8000 } as const;
export const AI_MAX_CARDS_LIMIT = 20;
export const AI_DEFAULT_MAX_CARDS = 8;

export const AI_JOB_STATUSES = ["pending_publish", "queued", "processing", "succeeded", "failed"] as const;
export const AiJobStatusSchema = z.enum(AI_JOB_STATUSES);

export const LLM_PROVIDERS = ["ollama", "lmstudio", "openrouter"] as const;
export const LlmProviderSchema = z.enum(LLM_PROVIDERS);

const aiInput = z.string().trim()
  .min(AI_INPUT_LIMITS.min, `Texto muito curto (mínimo de ${AI_INPUT_LIMITS.min} caracteres)`)
  .max(AI_INPUT_LIMITS.max, `Texto muito longo (máximo de ${AI_INPUT_LIMITS.max} caracteres)`);
const maxCards = z.number().int().min(1).max(AI_MAX_CARDS_LIMIT);

// ---- API HTTP ----

/** Corpo de POST /api/ai/jobs. A mesma idempotencyKey devolve o mesmo job. */
export const CreateAiJobSchema = z.object({
  input: aiInput,
  targetColumnId: ColumnIdSchema,
  idempotencyKey: z.uuid(),
  maxCards: maxCards.default(AI_DEFAULT_MAX_CARDS),
});

/** Resposta de POST e GET /api/ai/jobs. */
export const AiJobSchema = z.object({
  id: AiJobIdSchema,
  status: AiJobStatusSchema,
  input: z.string(),
  // Fica nulo se a coluna de destino for excluída enquanto o job está na fila.
  targetColumnId: ColumnIdSchema.nullable(),
  maxCards,
  cardIds: z.array(CardIdSchema),
  error: z.string().nullable(),
  provider: LlmProviderSchema.nullable(),
  model: z.string().nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
});

// ---- Mensagens do RabbitMQ ----

/** Limite da descrição gerada (o mesmo do painel de detalhes do cartão). */
export const AI_DESCRIPTION_LIMIT = 160;

/** O LLM só produz conteúdo; IDs, coluna e posição são decididos pelo Serviço A. */
export const GeneratedCardSchema = z.object({
  title: CardSchema.shape.title,
  description: z.string().trim().min(1).max(AI_DESCRIPTION_LIMIT).nullable(),
});

const envelope = {
  schemaVersion: z.literal(1),
  messageId: z.uuid(),
  jobId: AiJobIdSchema,
  // Vem do X-Request-Id do NGINX: permite seguir a mesma operação nos logs de todos os serviços.
  correlationId: z.string().min(1).max(200),
  createdAt: z.iso.datetime({ offset: true }),
};

/** Comando publicado pelo Serviço A e consumido pelo worker. */
export const GenerateCardsCommandSchema = z.object({
  ...envelope,
  type: z.literal("cards.generate"),
  payload: z.object({
    boardId: BoardIdSchema,
    targetColumnId: ColumnIdSchema,
    input: aiInput,
    maxCards,
    locale: z.literal("pt-BR"),
    promptVersion: z.string().min(1),
  }),
});

// Identifica a réplica do worker (hostname do pod), para mostrar a distribuição da fila.
const worker = z.string().min(1).max(200);

export const AI_FAILURE_CODES = ["invalid_output", "llm_unavailable", "timeout", "unauthorized", "unknown"] as const;

export const AiJobEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...envelope,
    type: z.literal("cards.generation_started"),
    worker,
  }),
  z.object({
    ...envelope,
    type: z.literal("cards.generated"),
    worker,
    provider: LlmProviderSchema,
    model: z.string().min(1).max(200),
    durationMs: z.number().int().nonnegative(),
    payload: z.object({ cards: z.array(GeneratedCardSchema).min(1).max(AI_MAX_CARDS_LIMIT) }),
  }),
  z.object({
    ...envelope,
    type: z.literal("cards.generation_failed"),
    worker,
    provider: LlmProviderSchema.nullable(),
    model: z.string().min(1).max(200).nullable(),
    payload: z.object({ code: z.enum(AI_FAILURE_CODES), message: z.string().min(1).max(500) }),
  }),
]);

/*
 * Topologia do broker. Os dois serviços declaram a mesma topologia ao conectar
 * (as declarações são idempotentes), então qualquer um pode subir primeiro.
 * Filas quorum são duráveis; depois de 3 entregas sem ack a mensagem vai para a DLQ.
 */
export const AI_MESSAGING = {
  exchanges: {
    commands: "taskflow.commands",
    events: "taskflow.events",
    deadLetter: "taskflow.dlx",
  },
  queues: {
    generate: "ai.generate",
    results: "ai.results",
    generateDeadLetter: "ai.generate.dlq",
    resultsDeadLetter: "ai.results.dlq",
  },
  routingKeys: {
    generate: "cards.generate",
    events: ["cards.generation_started", "cards.generated", "cards.generation_failed"],
  },
  deliveryLimit: 3,
} as const;

/** O suficiente de um canal AMQP para declarar a topologia (o amqplib atende a esta forma). */
export interface TopologyChannel {
  assertExchange(name: string, type: "direct", options: { durable: boolean }): Promise<unknown>;
  assertQueue(name: string, options: { durable: boolean; arguments: Record<string, string | number> }): Promise<unknown>;
  bindQueue(queue: string, exchange: string, routingKey: string): Promise<unknown>;
}

/** Declara exchanges, filas quorum, DLQs e ligações usadas pelo Agente de IA. */
export async function assertAiTopology(channel: TopologyChannel): Promise<void> {
  const { exchanges, queues, routingKeys } = AI_MESSAGING;
  for (const exchange of Object.values(exchanges)) {
    await channel.assertExchange(exchange, "direct", { durable: true });
  }
  for (const [queue, deadLetterQueue] of [
    [queues.generate, queues.generateDeadLetter],
    [queues.results, queues.resultsDeadLetter],
  ] as const) {
    await channel.assertQueue(deadLetterQueue, { durable: true, arguments: { "x-queue-type": "quorum" } });
    await channel.bindQueue(deadLetterQueue, exchanges.deadLetter, deadLetterQueue);
    await channel.assertQueue(queue, {
      durable: true,
      arguments: {
        "x-queue-type": "quorum",
        "x-delivery-limit": AI_MESSAGING.deliveryLimit,
        "x-dead-letter-exchange": exchanges.deadLetter,
        "x-dead-letter-routing-key": deadLetterQueue,
      },
    });
  }
  await channel.bindQueue(queues.generate, exchanges.commands, routingKeys.generate);
  for (const routingKey of routingKeys.events) {
    await channel.bindQueue(queues.results, exchanges.events, routingKey);
  }
}
