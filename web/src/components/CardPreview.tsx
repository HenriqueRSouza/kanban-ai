import type { CardId } from "@taskflow/shared";
import { useCard } from "../store/boardStore.ts";
import { DueDateBadge } from "./DueDateBadge.tsx";
import { TagChip } from "./TagChip.tsx";

/**
 * Cópia do cartão que "flutua" sob o cursor/dedo durante o arrasto (DragOverlay).
 * É só visual: não tem edição nem useSortable, por isso é um componente separado.
 */
export function CardPreview({ id }: { id: CardId }) {
  const card = useCard(id);
  if (!card) return null;

  return (
    <div className="rotate-2 cursor-grabbing rounded-2xl border border-ink bg-white p-3 shadow-xl">
      <p className="text-sm font-medium break-words">{card.title}</p>
      {card.description && <p className="mt-1 text-sm leading-relaxed break-words text-neutral-600">{card.description}</p>}
      {(card.tagIds.length > 0 || card.dueDate || card.observation) && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {card.dueDate && <DueDateBadge dueDate={card.dueDate} columnId={card.columnId} />}
          {card.tagIds.map((tagId) => (
            <TagChip key={tagId} id={tagId} />
          ))}
          {card.observation && (
            <span title="Este cartão tem observação" className="ml-auto text-neutral-400">
              <svg viewBox="0 0 16 16" aria-label="Tem observação" role="img" className="h-3.5 w-3.5">
                <path d="M3 4h10M3 8h10M3 12h6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
