import { AiJobIdSchema, AiJobSchema, BoardSnapshotSchema, CardIdSchema } from "@taskflow/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAiJobsStore } from "../store/aiJobsStore.ts";
import { useBoardStore } from "../store/boardStore.ts";
import { AiAgentButton } from "./AiAgentButton.tsx";
import { AiAgentDialog } from "./AiAgentDialog.tsx";

const TODO = "00000000-0000-4000-8000-000000000001";
const DOING = "00000000-0000-4000-8000-000000000002";
const snapshot = BoardSnapshotSchema.pick({ columns: true, cards: true, tags: true }).parse({
  columns: [
    { id: TODO, title: "A Fazer", position: 1000 },
    { id: DOING, title: "Fazendo", position: 2000 },
  ],
  cards: [],
  tags: [],
});
const story = "Como aluno, quero exportar o quadro em PDF";

function jobResponse(body: { idempotencyKey: string; input: string; targetColumnId: string; maxCards: number }) {
  return AiJobSchema.parse({
    id: crypto.randomUUID(), status: "pending_publish", input: body.input, targetColumnId: body.targetColumnId,
    maxCards: body.maxCards, cardIds: [], error: null, provider: null, model: null,
    createdAt: "2026-10-21T12:00:00.000Z", updatedAt: "2026-10-21T12:00:00.000Z", completedAt: null,
  });
}

function requestBody(call: unknown[] | undefined) {
  const init = call?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as { idempotencyKey: string; input: string; targetColumnId: string; maxCards: number };
}

beforeEach(() => {
  localStorage.clear();
  useBoardStore.getState().hydrate(snapshot);
  useAiJobsStore.setState({ jobs: [] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("painel do Agente de IA", () => {
  it("mostra as colunas do quadro e recusa texto curto sem chamar a API", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<AiAgentDialog onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Agente de IA" })).toHaveAttribute("open");
    expect(screen.getAllByRole("option", { name: /A Fazer|Fazendo/ }).map((option) => option.textContent)).toEqual(["A Fazer", "Fazendo"]);

    fireEvent.change(screen.getByLabelText("Texto"), { target: { value: "curto" } });
    fireEvent.click(screen.getByRole("button", { name: "Gerar cartões" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Texto muito curto");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("envia o pedido pelo /api, limpa o texto e mostra o pedido na lista", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) =>
      Response.json(jobResponse(JSON.parse(String(init?.body))), { status: 202 }));
    render(<AiAgentDialog onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Texto"), { target: { value: `  ${story}  ` } });
    fireEvent.change(screen.getByLabelText("Criar na coluna"), { target: { value: DOING } });
    fireEvent.change(screen.getByLabelText("Até"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Gerar cartões" }));

    await screen.findByText("Enviando para a fila");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/ai/jobs");
    expect(requestBody(fetchSpy.mock.calls[0])).toEqual({
      input: story, targetColumnId: DOING, maxCards: 3, idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(screen.getByLabelText("Texto")).toHaveValue("");
    expect(screen.getByText(story)).toBeInTheDocument();
  });

  it("após falha de rede, reenvia com a mesma chave para não duplicar o pedido", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockImplementation(async (_url, init) => Response.json(jobResponse(JSON.parse(String(init?.body))), { status: 202 }));
    render(<AiAgentDialog onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Texto"), { target: { value: story } });
    fireEvent.click(screen.getByRole("button", { name: "Gerar cartões" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sem conexão com o servidor");
    expect(screen.getByLabelText("Texto")).toHaveValue(story);

    fireEvent.click(screen.getByRole("button", { name: "Gerar cartões" }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(requestBody(fetchSpy.mock.calls[1]).idempotencyKey).toBe(requestBody(fetchSpy.mock.calls[0]).idempotencyKey);
  });

  it("mostra o erro da API, o resultado e a falha de cada pedido", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "Coluna de destino não encontrada" }, { status: 404 }));
    const done = jobResponse({ idempotencyKey: "", input: "Pedido concluído", targetColumnId: TODO, maxCards: 8 });
    useAiJobsStore.setState({ jobs: [
      { ...done, status: "succeeded", cardIds: [CardIdSchema.parse(crypto.randomUUID()), CardIdSchema.parse(crypto.randomUUID())], provider: "ollama", model: "qwen3:1.7b" },
      { ...done, id: AiJobIdSchema.parse(crypto.randomUUID()), input: "Pedido com falha", status: "failed", error: "O modelo não respondeu em 120 s" },
    ] });
    render(<AiAgentDialog onClose={vi.fn()} />);
    expect(screen.getByText("2 cartões criados em A Fazer · ollama · qwen3:1.7b")).toBeInTheDocument();
    expect(screen.getByText("O modelo não respondeu em 120 s")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Texto"), { target: { value: story } });
    fireEvent.click(screen.getByRole("button", { name: "Gerar cartões" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Coluna de destino não encontrada");

    fireEvent.click(screen.getAllByRole("button", { name: "Remover da lista" })[0]!);
    expect(useAiJobsStore.getState().jobs).toHaveLength(1);
  });
});

describe("botão do Agente de IA", () => {
  it("abre o painel e mostra quantos pedidos estão em andamento", () => {
    const base = jobResponse({ idempotencyKey: "", input: story, targetColumnId: TODO, maxCards: 8 });
    useAiJobsStore.setState({ jobs: [
      { ...base, status: "processing" },
      { ...base, id: AiJobIdSchema.parse(crypto.randomUUID()), status: "queued" },
      { ...base, id: AiJobIdSchema.parse(crypto.randomUUID()), status: "succeeded" },
    ] });
    render(<AiAgentButton />);
    fireEvent.click(screen.getByRole("button", { name: "Agente de IA, 2 em andamento" }));
    expect(screen.getByRole("dialog", { name: "Agente de IA" })).toBeInTheDocument();
  });
});
