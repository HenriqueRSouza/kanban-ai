import type { CardId, TagId } from "@taskflow/shared";
import { TAG_COLOR_CLASSES } from "../lib/tagColors.ts";
import { useBoardStore, useCard, useTags } from "../store/boardStore.ts";

/**
 * Lista todas as etiquetas do quadro com uma caixa de seleção para o cartão.
 * Etiquetas novas são criadas no quadro, pelo TagCreator da linha dos filtros.
 */
export function TagPicker({ cardId }: { cardId: CardId }) {
  const card = useCard(cardId);
  const tags = useTags();
  const toggleCardTag = useBoardStore((s) => s.toggleCardTag);
  const removeTag = useBoardStore((s) => s.removeTag);

  if (!card) return null;
  const allTags = Object.values(tags).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  function handleRemove(tagId: TagId, tagName: string) {
    if (window.confirm(`Excluir a etiqueta "${tagName}" de todos os cartões?`)) removeTag(tagId);
  }

  return (
    <div>
      {allTags.length === 0 ? (
        <p className="text-sm text-neutral-500">Nenhuma etiqueta ainda. Crie pelo botão “+ Etiqueta”, ao lado dos filtros.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {allTags.map((tag) => {
            const checked = card.tagIds.includes(tag.id);
            return (
              <li key={tag.id} className="flex items-center">
                <label
                  className={`flex cursor-pointer items-center gap-1.5 rounded-l-full py-1 pl-2.5 pr-2 text-xs font-semibold transition ${
                    TAG_COLOR_CLASSES[tag.color]
                  } ${checked ? "" : "opacity-50 hover:opacity-100"}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleCardTag(cardId, tag.id)}
                    className="h-3.5 w-3.5 accent-ink"
                  />
                  {tag.name}
                </label>
                <button
                  type="button"
                  onClick={() => handleRemove(tag.id, tag.name)}
                  aria-label={`Excluir etiqueta ${tag.name}`}
                  className={`rounded-r-full py-1 pl-1 pr-2 text-xs transition ${TAG_COLOR_CLASSES[tag.color]} ${
                    checked ? "" : "opacity-50"
                  } hover:opacity-100`}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}

    </div>
  );
}
