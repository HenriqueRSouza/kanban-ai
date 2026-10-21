import { describe, expect, it } from "vitest";
import type { WorkerConfig } from "../src/config.ts";
import { createLlmClient, extractJson, LlmError, normalizeCards, type FetchFn } from "../src/llm/client.ts";

const ollama: WorkerConfig["llm"] = {
  provider: "ollama", baseUrl: "http://ollama:11434/v1", model: "qwen3:1.7b", apiKey: null, timeoutMs: 1000,
};
const openrouter: WorkerConfig["llm"] = {
  provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "x/y", apiKey: "sk-or-segredo", timeoutMs: 1000,
};

function completion(content: string | null): Response {
  return Response.json({ choices: [{ message: { role: "assistant", content } }] });
}

function recordingFetch(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("sem resposta preparada");
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, fetchFn };
}

async function llmError(promise: Promise<unknown>): Promise<LlmError> {
  const error: unknown = await promise.then(() => null, (reason: unknown) => reason);
  if (!(error instanceof LlmError)) throw new Error(`Esperava LlmError, veio ${String(error)}`);
  return error;
}

describe("Cliente LLM (API compatível com OpenAI)", () => {
  it("chama /chat/completions com modelo, prompts e JSON Schema, sem credencial no Ollama", async () => {
    const { calls, fetchFn } = recordingFetch([completion('{"cards":[{"title":"Criar fila","description":"Fila durável criada"}]}')]);
    const cards = await createLlmClient(ollama, fetchFn).generateCards("Como aluno, quero uma fila", 3);

    expect(cards).toEqual([{ title: "Criar fila", description: "Fila durável criada" }]);
    expect(calls[0]?.url).toBe("http://ollama:11434/v1/chat/completions");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    const body = JSON.parse(String(calls[0]?.init.body)) as {
      model: string; reasoning_effort?: string; messages: Array<{ role: string; content: string }>;
      response_format: { json_schema: { schema: { properties: { cards: { maxItems: number } } } } };
    };
    expect(body.model).toBe("qwen3:1.7b");
    expect(body.reasoning_effort).toBe("none");
    expect(body.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(body.messages.at(-1)?.content).toContain("Como aluno, quero uma fila");
    // O exemplo nunca mostra mais cartões do que o pedido permite.
    expect(JSON.parse(body.messages[2]?.content ?? "{}")).toHaveProperty("cards.length", 3);
    expect(body.response_format.json_schema.schema.properties.cards.maxItems).toBe(3);
  });

  it("envia o token e a identificação do app só para o OpenRouter", async () => {
    const { calls, fetchFn } = recordingFetch([completion('{"cards":[{"title":"A","description":null}]}')]);
    await createLlmClient(openrouter, fetchFn).generateCards("Planejamento do projeto", 1);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-or-segredo");
    expect(headers["X-Title"]).toBe("TaskFlow Agente de IA");
    expect(JSON.parse(String(calls[0]?.init.body))).not.toHaveProperty("reasoning_effort");
  });

  it("classifica credencial recusada como definitiva e sem vazar o token", async () => {
    const { fetchFn } = recordingFetch([new Response("unauthorized", { status: 401 })]);
    const error = await llmError(createLlmClient(openrouter, fetchFn).generateCards("Planejamento", 2));
    expect(error).toMatchObject({ code: "unauthorized", retryable: false });
    expect(error.message).not.toContain("sk-or-segredo");
  });

  it("classifica limite de uso, erro do servidor, conexão recusada e timeout como passageiros", async () => {
    for (const [response, code] of [
      [new Response("", { status: 429 }), "llm_unavailable"],
      [new Response("", { status: 503 }), "llm_unavailable"],
      [new Response("", { status: 404 }), "llm_unavailable"],
      [new TypeError("fetch failed: ECONNREFUSED http://ollama:11434 Bearer sk-or-segredo"), "llm_unavailable"],
      [Object.assign(new Error("timeout"), { name: "TimeoutError" }), "timeout"],
    ] as const) {
      const { fetchFn } = recordingFetch([response]);
      const error = await llmError(createLlmClient(ollama, fetchFn).generateCards("Planejamento", 2));
      expect(error).toMatchObject({ code, retryable: true });
      expect(error.message).not.toContain("sk-or-segredo");
    }
  });

  it("tenta uma segunda vez quando o modelo erra o formato e desiste na terceira", async () => {
    const recovered = recordingFetch([completion("não sei"), completion('{"cards":[{"title":"Ok","description":null}]}')]);
    expect(await createLlmClient(ollama, recovered.fetchFn).generateCards("Planejamento", 2)).toHaveLength(1);
    expect(recovered.calls).toHaveLength(2);

    const broken = recordingFetch([completion("não sei"), completion('{"cards":[]}')]);
    const error = await llmError(createLlmClient(ollama, broken.fetchFn).generateCards("Planejamento", 2));
    expect(error).toMatchObject({ code: "invalid_output", retryable: false });
  });
});

describe("Leitura da resposta do modelo", () => {
  it("ignora raciocínio <think> e cercas de código", () => {
    expect(extractJson('<think>vou pensar {x}</think>\n```json\n{"cards":[]}\n```')).toEqual({ cards: [] });
    expect(extractJson('Claro! {"cards":[{"title":"A"}]} Pronto.')).toEqual({ cards: [{ title: "A" }] });
    expect(() => extractJson("sem json")).toThrow(LlmError);
  });

  it("corta textos longos, descarta títulos vazios e respeita o máximo de cartões", () => {
    const cards = normalizeCards({
      cards: [
        { title: "  ", description: "sem título" },
        { title: "T".repeat(250), description: "D".repeat(300) },
        { title: "segundo", description: "  " },
        { title: "Terceiro" },
        { title: "Quarto", description: null },
      ],
    }, 3);
    expect(cards).toHaveLength(3);
    expect(cards[0]?.title).toHaveLength(200);
    expect(cards[0]?.title.endsWith("…")).toBe(true);
    expect(cards[0]?.description).toHaveLength(160);
    expect(cards[1]).toEqual({ title: "Segundo", description: null });
    expect(cards[2]).toEqual({ title: "Terceiro", description: null });
  });
});
