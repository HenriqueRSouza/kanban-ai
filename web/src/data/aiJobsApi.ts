import { AiJobSchema } from "@taskflow/shared";
import type { AiJob, AiJobId, CreateAiJobInput } from "@taskflow/shared";
import { requestJson } from "./http.ts";

/*
 * Pedidos do Agente de IA. O front só conversa com a API (Serviço A), pelo
 * NGINX: quem gera os cartões é o worker, do outro lado do RabbitMQ.
 */

/** Cria o pedido. Reenviar com a mesma idempotencyKey devolve o mesmo job. */
export async function createAiJob(body: CreateAiJobInput, baseUrl = "/api"): Promise<AiJob> {
  return AiJobSchema.parse(await requestJson(baseUrl, "POST", "/ai/jobs", body));
}

export async function fetchAiJob(id: AiJobId, baseUrl = "/api"): Promise<AiJob> {
  return AiJobSchema.parse(await requestJson(baseUrl, "GET", `/ai/jobs/${id}`));
}
