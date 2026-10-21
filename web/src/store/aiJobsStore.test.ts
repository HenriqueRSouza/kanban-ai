import { AiJobSchema, CardIdSchema } from "@taskflow/shared";
import type { AiJob, AiJobStatus } from "@taskflow/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, NetworkError } from "../data/BoardRepository.ts";
import { isActiveJob, refreshBoardUntilApplied, startAiJobPolling, useAiJobsStore } from "./aiJobsStore.ts";

function job(status: AiJobStatus, overrides: Partial<AiJob> = {}): AiJob {
  return AiJobSchema.parse({
    id: crypto.randomUUID(), status, input: "Como aluno, quero gerar cartões", targetColumnId: crypto.randomUUID(),
    maxCards: 8, cardIds: [], error: null, provider: null, model: null,
    createdAt: "2026-10-21T12:00:00.000Z", updatedAt: "2026-10-21T12:00:00.000Z", completedAt: null, ...overrides,
  });
}

beforeEach(() => {
  localStorage.clear();
  useAiJobsStore.setState({ jobs: [] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("lista de pedidos", () => {
  it("põe pedidos novos no topo, atualiza no lugar e guarda no máximo 8", () => {
    const first = job("queued");
    useAiJobsStore.getState().upsert(first);
    const second = job("queued");
    useAiJobsStore.getState().upsert(second);
    useAiJobsStore.getState().upsert({ ...first, status: "processing" });
    expect(useAiJobsStore.getState().jobs.map((item) => [item.id, item.status])).toEqual([
      [second.id, "queued"], [first.id, "processing"],
    ]);
    for (let index = 0; index < 10; index += 1) useAiJobsStore.getState().upsert(job("queued"));
    expect(useAiJobsStore.getState().jobs).toHaveLength(8);
  });

  it("só considera ativos os pedidos que ainda não terminaram", () => {
    expect(["pending_publish", "queued", "processing", "succeeded", "failed"].map((status) =>
      isActiveJob(job(status as AiJobStatus)))).toEqual([true, true, true, false, false]);
  });

  it("restaura do localStorage só o que passar no schema", async () => {
    const saved = job("processing");
    localStorage.setItem("taskflow-ai-jobs", JSON.stringify({ state: { jobs: [saved] }, version: 1 }));
    await useAiJobsStore.persist.rehydrate();
    expect(useAiJobsStore.getState().jobs).toEqual([saved]);

    useAiJobsStore.setState({ jobs: [] });
    localStorage.setItem("taskflow-ai-jobs", JSON.stringify({ state: { jobs: [{ id: "x" }] }, version: 1 }));
    await useAiJobsStore.persist.rehydrate();
    expect(useAiJobsStore.getState().jobs).toEqual([]);
  });
});

describe("acompanhamento", () => {
  it("consulta os pedidos ativos e recarrega o quadro quando um termina", async () => {
    vi.useFakeTimers();
    const queued = job("queued");
    const done = job("succeeded");
    useAiJobsStore.setState({ jobs: [queued, done] });
    const replies = [
      { ...queued, status: "processing" as const },
      { ...queued, status: "succeeded" as const, cardIds: [CardIdSchema.parse(crypto.randomUUID())] },
    ];
    const fetchJob = vi.fn(async () => replies.shift() ?? queued);
    const refreshBoard = vi.fn(async () => true);

    const stop = startAiJobPolling({ fetchJob, refreshBoard, intervalMs: 2000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(useAiJobsStore.getState().jobs[0]?.status).toBe("processing");
    expect(refreshBoard).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    expect(useAiJobsStore.getState().jobs[0]?.status).toBe("succeeded");
    expect(refreshBoard).toHaveBeenCalledTimes(1);

    // Pedidos terminados não são consultados de novo.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchJob).toHaveBeenCalledTimes(2);
    expect(fetchJob).not.toHaveBeenCalledWith(done.id);
    stop();
  });

  it("encerra pedido que o servidor não conhece e mantém o resto em caso de rede fora", async () => {
    const lost = job("queued");
    const offline = job("processing");
    useAiJobsStore.setState({ jobs: [lost, offline] });
    const fetchJob = vi.fn(async (id: string) => {
      throw id === lost.id ? new ApiError(404, "Job não encontrado") : new NetworkError(new Error("sem rede"));
    });
    const stop = startAiJobPolling({ fetchJob, refreshBoard: vi.fn(), intervalMs: 60_000 });
    await vi.waitFor(() => expect(fetchJob).toHaveBeenCalledTimes(2));
    stop();
    const [first, second] = useAiJobsStore.getState().jobs;
    expect(first).toMatchObject({ status: "failed", error: "O servidor não encontrou este pedido." });
    expect(second).toEqual(offline);
  });

  it("tenta recarregar o quadro de novo quando a carga é adiada", async () => {
    const load = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    expect(await refreshBoardUntilApplied(load, 5, 0)).toBe(true);
    expect(load).toHaveBeenCalledTimes(3);
    expect(await refreshBoardUntilApplied(vi.fn().mockResolvedValue(false), 2, 0)).toBe(false);
  });
});
