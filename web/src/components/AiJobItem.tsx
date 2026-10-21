import type { AiJob, AiJobStatus } from "@taskflow/shared";
import { useBoardStore } from "../store/boardStore.ts";
import { isActiveJob, useAiJobsStore } from "../store/aiJobsStore.ts";

// Record<AiJobStatus, ...>: o TypeScript obriga a tratar todos os status.
const STATUS: Record<AiJobStatus, { label: string; chip: string }> = {
  pending_publish: { label: "Enviando para a fila", chip: "bg-neutral-200 text-neutral-700" },
  queued: { label: "Na fila", chip: "bg-neutral-200 text-neutral-700" },
  processing: { label: "Gerando cartões…", chip: "bg-brand-400 text-ink animate-pulse" },
  succeeded: { label: "Concluído", chip: "bg-green-100 text-green-800" },
  failed: { label: "Falhou", chip: "bg-red-100 text-red-800" },
};

/** Um pedido do Agente de IA na lista do painel. */
export function AiJobItem({ job }: { job: AiJob }) {
  const columnTitle = useBoardStore((s) => (job.targetColumnId ? s.columns[job.targetColumnId]?.title : undefined));
  const dismiss = useAiJobsStore((s) => s.dismiss);
  const status = STATUS[job.status];
  const count = job.cardIds.length;

  return (
    <li className="space-y-2 rounded-2xl bg-tile p-3 text-sm">
      <div className="flex items-start gap-2">
        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${status.chip}`}>{status.label}</span>
        <p className="line-clamp-2 min-w-0 flex-1 text-neutral-700">{job.input}</p>
        {!isActiveJob(job) && (
          <button
            type="button"
            onClick={() => dismiss(job.id)}
            aria-label="Remover da lista"
            className="shrink-0 rounded-full px-2 text-neutral-500 transition hover:bg-neutral-200 hover:text-ink"
          >
            ×
          </button>
        )}
      </div>
      {job.status === "succeeded" && (
        <p className="text-xs text-neutral-600">
          {count} {count === 1 ? "cartão criado" : "cartões criados"}
          {columnTitle ? ` em ${columnTitle}` : ""}
          {job.provider && job.model ? ` · ${job.provider} · ${job.model}` : ""}
        </p>
      )}
      {job.status === "failed" && job.error && <p className="text-xs text-red-700">{job.error}</p>}
    </li>
  );
}
