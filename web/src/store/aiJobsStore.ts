import { AiJobSchema } from "@taskflow/shared";
import type { AiJob, AiJobId, AiJobStatus, CreateAiJobInput } from "@taskflow/shared";
import { z } from "zod";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createAiJob, fetchAiJob } from "../data/aiJobsApi.ts";
import { ApiError } from "../data/BoardRepository.ts";
import { syncEngine, syncEnabled } from "../data/sync.ts";

/** Quantos pedidos recentes ficam na lista do painel. */
const MAX_JOBS = 8;
const POLL_INTERVAL_MS = 2000;
const REFRESH_ATTEMPTS = 10;
const REFRESH_RETRY_MS = 1500;

const TERMINAL_STATUSES: readonly AiJobStatus[] = ["succeeded", "failed"];

export function isActiveJob(job: AiJob): boolean {
  return !TERMINAL_STATUSES.includes(job.status);
}

interface AiJobsState {
  /** Do mais recente para o mais antigo. */
  jobs: AiJob[];
  upsert: (job: AiJob) => void;
  dismiss: (id: AiJobId) => void;
}

const StoredJobsSchema = z.object({ jobs: z.array(AiJobSchema) });

/**
 * Pedidos do Agente de IA acompanhados nesta aba. Ficam no localStorage para o
 * acompanhamento continuar depois de recarregar a página.
 */
export const useAiJobsStore = create<AiJobsState>()(
  persist(
    (set) => ({
      jobs: [],
      upsert: (job) => set((state) => {
        const known = state.jobs.some((item) => item.id === job.id);
        const jobs = known ? state.jobs.map((item) => (item.id === job.id ? job : item)) : [job, ...state.jobs];
        return { jobs: jobs.slice(0, MAX_JOBS) };
      }),
      dismiss: (id) => set((state) => ({ jobs: state.jobs.filter((job) => job.id !== id) })),
    }),
    {
      name: "taskflow-ai-jobs",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ jobs: state.jobs }),
      // localStorage é dado externo: só aproveita o que passar no schema.
      merge: (persisted, current) => {
        const result = StoredJobsSchema.safeParse(persisted);
        return result.success ? { ...current, jobs: result.data.jobs } : current;
      },
    },
  ),
);

export async function submitAiJob(body: CreateAiJobInput): Promise<AiJob> {
  const job = await createAiJob(body);
  useAiJobsStore.getState().upsert(job);
  return job;
}

/**
 * Recarrega o quadro do servidor para mostrar os cartões gerados. O motor de
 * sincronização adia a carga se o usuário estiver mexendo no quadro (para não
 * apagar a mudança dele); nesse caso tenta de novo um pouco depois.
 */
export async function refreshBoardUntilApplied(
  load: () => Promise<boolean> = () => syncEngine.loadFromServer(),
  attempts = REFRESH_ATTEMPTS,
  retryMs = REFRESH_RETRY_MS,
): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await load()) return true;
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
  return false;
}

interface PollingOptions {
  fetchJob?: (id: AiJobId) => Promise<AiJob>;
  refreshBoard?: () => Promise<unknown>;
  intervalMs?: number;
}

/**
 * Consulta os pedidos em andamento a cada 2 s. Quando um termina com sucesso,
 * recarrega o quadro. Devolve a função que para (cleanup do useEffect).
 */
export function startAiJobPolling(options: PollingOptions = {}): () => void {
  const fetchJob = options.fetchJob ?? ((id: AiJobId) => fetchAiJob(id));
  const refreshBoard = options.refreshBoard ?? (() => (syncEnabled ? refreshBoardUntilApplied() : Promise.resolve(false)));
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function poll(job: AiJob): Promise<void> {
    try {
      const latest = await fetchJob(job.id);
      if (stopped) return;
      useAiJobsStore.getState().upsert(latest);
      if (latest.status === "succeeded") void refreshBoard();
    } catch (error) {
      // O servidor não conhece o pedido (banco recriado): encerra o acompanhamento.
      // Erro de rede: tenta de novo na próxima rodada.
      if (error instanceof ApiError && error.status === 404) {
        useAiJobsStore.getState().upsert({ ...job, status: "failed", error: "O servidor não encontrou este pedido." });
      }
    }
  }

  async function tick(): Promise<void> {
    await Promise.all(useAiJobsStore.getState().jobs.filter(isActiveJob).map(poll));
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  }

  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
