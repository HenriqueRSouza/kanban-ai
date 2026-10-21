import { hostname } from "node:os";
import { LlmProviderSchema, type LlmProvider } from "@taskflow/shared";
import { z } from "zod";

/** Padrões de cada provedor de LLM (todos expõem a API compatível com OpenAI). */
export const PROVIDER_DEFAULTS: Record<LlmProvider, { baseUrl: string; model: string | null }> = {
  ollama: { baseUrl: "http://ollama:11434/v1", model: "qwen3:1.7b" },
  lmstudio: { baseUrl: "http://host.docker.internal:1234/v1", model: "qwen/qwen3-8b" },
  // No OpenRouter o modelo é escolha de quem configura (catálogo muda com frequência).
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: null },
};

// Variável vazia no .env conta como "não definida".
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const EnvSchema = z.object({
  RABBITMQ_URL: z.string().min(1, "RABBITMQ_URL é obrigatória"),
  LLM_PROVIDER: z.preprocess((value) => (value === "" ? undefined : value), LlmProviderSchema.default("ollama")),
  LLM_BASE_URL: optional(z.url()),
  LLM_MODEL: optional(z.string().min(1)),
  LLM_API_KEY: optional(z.string().min(1)),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  HEALTH_PORT: z.coerce.number().int().positive().default(8080),
  WORKER_NAME: optional(z.string().min(1)),
});

export interface WorkerConfig {
  rabbitmqUrl: string;
  llm: {
    provider: LlmProvider;
    baseUrl: string;
    model: string;
    apiKey: string | null;
    timeoutMs: number;
  };
  healthPort: number;
  workerName: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Lê e valida as variáveis de ambiente. Configuração inválida derruba o worker na partida. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigError(`Configuração inválida em ${issue?.path.join(".") ?? "?"}: ${issue?.message ?? ""}`);
  }
  const vars = parsed.data;
  const defaults = PROVIDER_DEFAULTS[vars.LLM_PROVIDER];
  const model = vars.LLM_MODEL ?? defaults.model;
  if (!model) throw new ConfigError(`Defina LLM_MODEL para o provedor ${vars.LLM_PROVIDER}`);
  if (vars.LLM_PROVIDER === "openrouter" && !vars.LLM_API_KEY) {
    throw new ConfigError("Defina LLM_API_KEY (token do OpenRouter) no .env");
  }
  return {
    rabbitmqUrl: vars.RABBITMQ_URL,
    llm: {
      provider: vars.LLM_PROVIDER,
      baseUrl: (vars.LLM_BASE_URL ?? defaults.baseUrl).replace(/\/+$/, ""),
      model,
      apiKey: vars.LLM_API_KEY ?? null,
      timeoutMs: vars.LLM_TIMEOUT_MS,
    },
    healthPort: vars.HEALTH_PORT,
    workerName: vars.WORKER_NAME ?? hostname(),
  };
}
