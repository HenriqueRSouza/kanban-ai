import {
  AI_DESCRIPTION_LIMIT,
  GeneratedCardSchema,
  TITLE_LIMITS,
  type GeneratedCard,
} from "@taskflow/shared";
import { z } from "zod";
import type { WorkerConfig } from "../config.ts";
import { buildMessages, responseJsonSchema } from "./prompt.ts";

export type LlmErrorCode = "invalid_output" | "llm_unavailable" | "timeout" | "unauthorized";

/** Erro do provedor já classificado. `retryable` decide entre devolver à fila ou falhar o job. */
export class LlmError extends Error {
  constructor(
    public readonly code: LlmErrorCode,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export interface LlmClient {
  generateCards(input: string, maxCards: number): Promise<GeneratedCard[]>;
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const CompletionSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string().nullable() }),
  })).min(1),
});

const RawOutputSchema = z.object({
  cards: z.array(z.object({
    title: z.unknown(),
    description: z.unknown().optional(),
  })),
});

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Extrai o JSON da resposta. Modelos pequenos às vezes devolvem raciocínio
 * (<think>…</think>) ou cercas de código mesmo com o formato pedido.
 */
export function extractJson(content: string): unknown {
  const withoutThinking = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(withoutThinking);
  const candidate = fenced?.[1] ?? withoutThinking;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new LlmError("invalid_output", "O modelo não respondeu com JSON", false);
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new LlmError("invalid_output", "O modelo respondeu com JSON malformado", false);
  }
}

/** Ajusta a saída do modelo aos limites do quadro em vez de descartar um resultado quase certo. */
export function normalizeCards(raw: unknown, maxCards: number): GeneratedCard[] {
  const parsed = RawOutputSchema.safeParse(raw);
  if (!parsed.success) throw new LlmError("invalid_output", "Resposta do modelo fora do formato esperado", false);
  const cards: GeneratedCard[] = [];
  for (const item of parsed.data.cards) {
    if (typeof item.title !== "string" || item.title.trim() === "") continue;
    const description = typeof item.description === "string" && item.description.trim() !== ""
      ? truncate(item.description.trim(), AI_DESCRIPTION_LIMIT)
      : null;
    const title = item.title.trim();
    const card = GeneratedCardSchema.safeParse({
      title: truncate(title.charAt(0).toLocaleUpperCase("pt-BR") + title.slice(1), TITLE_LIMITS.card),
      description,
    });
    if (card.success) cards.push(card.data);
    if (cards.length === maxCards) break;
  }
  if (cards.length === 0) throw new LlmError("invalid_output", "O modelo não gerou nenhum cartão válido", false);
  return cards;
}

function classifyStatus(status: number): LlmError {
  if (status === 401 || status === 403) {
    return new LlmError("unauthorized", "O provedor de IA recusou a credencial (verifique LLM_API_KEY)", false);
  }
  // 404 também acontece enquanto o modelo ainda está sendo baixado ou carregado.
  if (status === 404) {
    return new LlmError("llm_unavailable", "Modelo não encontrado no provedor (ainda baixando ou LLM_MODEL errado)", true);
  }
  if (status === 408 || status === 429 || status >= 500) {
    return new LlmError("llm_unavailable", `Provedor de IA indisponível no momento (HTTP ${status})`, true);
  }
  return new LlmError("llm_unavailable", `O provedor de IA recusou a requisição (HTTP ${status})`, false);
}

export function createLlmClient(config: WorkerConfig["llm"], fetchFn: FetchFn = fetch): LlmClient {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  if (config.provider === "openrouter") {
    // Identificação opcional do app no painel do OpenRouter.
    headers["HTTP-Referer"] = "https://github.com/HenriqueRSouza/kanban-ai";
    headers["X-Title"] = "TaskFlow Agente de IA";
  }

  async function complete(input: string, maxCards: number): Promise<string> {
    let response: Response;
    try {
      response = await fetchFn(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(config.timeoutMs),
        body: JSON.stringify({
          model: config.model,
          temperature: 0.2,
          // Desliga o raciocínio dos modelos "thinking" (ex.: qwen3) no Ollama: em CPU,
          // ele gerava ~4x mais tokens (864 contra 182) sem melhorar os cartões.
          ...(config.provider === "ollama" ? { reasoning_effort: "none" } : {}),
          messages: buildMessages(input, maxCards),
          response_format: {
            type: "json_schema",
            json_schema: { name: "cards", strict: true, schema: responseJsonSchema(maxCards) },
          },
        }),
      });
    } catch (error: unknown) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new LlmError("timeout", `O modelo não respondeu em ${Math.round(config.timeoutMs / 1000)} s`, true);
      }
      // Mensagem genérica: o erro original pode carregar a URL e os headers da requisição.
      throw new LlmError("llm_unavailable", `Não foi possível conectar ao provedor ${config.provider}`, true);
    }
    if (!response.ok) throw classifyStatus(response.status);
    const completion = CompletionSchema.safeParse(await response.json().catch(() => null));
    const content = completion.success ? completion.data.choices[0]?.message.content : null;
    if (!content) throw new LlmError("invalid_output", "O provedor devolveu uma resposta vazia", false);
    return content;
  }

  return {
    async generateCards(input, maxCards) {
      // Modelos pequenos erram o formato de vez em quando: uma segunda tentativa
      // no próprio worker é mais barata que devolver a mensagem à fila.
      try {
        return normalizeCards(extractJson(await complete(input, maxCards)), maxCards);
      } catch (error: unknown) {
        if (!(error instanceof LlmError) || error.code !== "invalid_output") throw error;
        return normalizeCards(extractJson(await complete(input, maxCards)), maxCards);
      }
    },
  };
}
