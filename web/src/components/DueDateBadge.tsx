import type { ColumnId } from "@taskflow/shared";
import { formatDueDate, isOverdue } from "../lib/dueDate.ts";
import { useIsInLastColumn } from "../store/boardStore.ts";

/** Prazo do cartão; fica vermelho quando atrasado (exceto na última coluna, a de concluídos). */
export function DueDateBadge({ dueDate, columnId }: { dueDate: string; columnId: ColumnId }) {
  const isDone = useIsInLastColumn(columnId);
  const overdue = !isDone && isOverdue(dueDate);
  const label = formatDueDate(dueDate);

  return (
    <span
      aria-label={overdue ? `Entrega atrasada: ${label}` : `Entrega em ${label}`}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold ${
        overdue ? "bg-red-600 text-white" : "bg-tile text-neutral-600"
      }`}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3 w-3">
        <path d="M3 4h10v9H3zM3 7h10M6 2v3M10 2v3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {label}
    </span>
  );
}
