import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.ts";

const base = { RABBITMQ_URL: "amqp://rabbitmq", WORKER_NAME: "worker-1" };

describe("Configuração do worker", () => {
  it("usa Ollama por padrão, sem nenhuma variável de LLM", () => {
    expect(loadConfig(base)).toEqual({
      rabbitmqUrl: "amqp://rabbitmq",
      llm: { provider: "ollama", baseUrl: "http://ollama:11434/v1", model: "qwen3:1.7b", apiKey: null, timeoutMs: 120_000 },
      healthPort: 8080,
      workerName: "worker-1",
    });
  });

  it("trata variáveis vazias do .env como não definidas", () => {
    const config = loadConfig({ ...base, LLM_PROVIDER: "", LLM_BASE_URL: "", LLM_MODEL: "", LLM_API_KEY: "" });
    expect(config.llm).toMatchObject({ provider: "ollama", model: "qwen3:1.7b", apiKey: null });
  });

  it("aplica os padrões do LM Studio e aceita URL e modelo próprios", () => {
    expect(loadConfig({ ...base, LLM_PROVIDER: "lmstudio" }).llm).toMatchObject({
      baseUrl: "http://host.docker.internal:1234/v1", model: "qwen/qwen3-8b",
    });
    expect(loadConfig({
      ...base, LLM_PROVIDER: "lmstudio", LLM_BASE_URL: "http://localhost:1234/v1/", LLM_MODEL: "qwen/qwen3-14b",
    }).llm).toMatchObject({ baseUrl: "http://localhost:1234/v1", model: "qwen/qwen3-14b" });
  });

  it("exige token e modelo para o OpenRouter", () => {
    expect(() => loadConfig({ ...base, LLM_PROVIDER: "openrouter", LLM_MODEL: "x/y" })).toThrow(/LLM_API_KEY/);
    expect(() => loadConfig({ ...base, LLM_PROVIDER: "openrouter", LLM_API_KEY: "sk-or-1" })).toThrow(/LLM_MODEL/);
    expect(loadConfig({ ...base, LLM_PROVIDER: "openrouter", LLM_API_KEY: "sk-or-1", LLM_MODEL: "x/y" }).llm)
      .toMatchObject({ baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or-1", model: "x/y" });
  });

  it("recusa provedor desconhecido, URL inválida e falta do RabbitMQ", () => {
    expect(() => loadConfig({ ...base, LLM_PROVIDER: "gpt" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, LLM_BASE_URL: "não é url" })).toThrow(/LLM_BASE_URL/);
    expect(() => loadConfig({})).toThrow(/RABBITMQ_URL/);
  });
});
