import { useState } from "react";
import type { FormEvent } from "react";
import { TAG_COLORS, TITLE_LIMITS } from "@taskflow/shared";
import type { TagColor } from "@taskflow/shared";
import { TAG_COLOR_CLASSES, TAG_COLOR_LABELS } from "../lib/tagColors.ts";
import { useBoardStore } from "../store/boardStore.ts";

/**
 * Criador de etiquetas do quadro, discreto na linha dos filtros: um botão que
 * abre, na própria linha, o campo de nome e as cores.
 */
export function TagCreator() {
  const [isOpen, setIsOpen] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState<TagColor>("yellow");

  function close() {
    setName("");
    setIsOpen(false);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // createTag devolve null se o nome for inválido: aí o formulário fica aberto.
    if (useBoardStore.getState().createTag(name, color)) close();
  }

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="shrink-0 rounded-full border border-dashed border-neutral-300 px-2.5 py-1 text-[11px] font-semibold text-neutral-500 transition hover:border-ink hover:text-ink"
      >
        + Etiqueta
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      onKeyDown={(event) => event.key === "Escape" && close()}
      className="flex shrink-0 items-center gap-2 rounded-full border border-neutral-300 py-0.5 pl-1 pr-0.5"
    >
      <input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={TITLE_LIMITS.tag}
        placeholder="Nova etiqueta"
        aria-label="Nome da nova etiqueta"
        className="w-32 rounded-full px-2 py-0.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500"
      />

      {/* Grupo de rádios: escolher UMA cor. fieldset + legend dão o nome do grupo ao leitor de tela. */}
      <fieldset className="flex items-center gap-1">
        <legend className="sr-only">Cor da etiqueta</legend>
        {TAG_COLORS.map((option) => (
          <label key={option} title={TAG_COLOR_LABELS[option]} className="cursor-pointer">
            <input
              type="radio"
              name="tag-color"
              value={option}
              checked={color === option}
              onChange={() => setColor(option)}
              className="peer sr-only"
            />
            <span className="sr-only">{TAG_COLOR_LABELS[option]}</span>
            <span
              aria-hidden="true"
              className={`block h-4 w-4 rounded-full border border-neutral-300 ${
                TAG_COLOR_CLASSES[option]
              } peer-checked:ring-2 peer-checked:ring-ink peer-checked:ring-offset-1 peer-focus-visible:outline-2 peer-focus-visible:outline-ink`}
            />
          </label>
        ))}
      </fieldset>

      <button
        type="submit"
        disabled={!name.trim()}
        className="rounded-full bg-ink px-2.5 py-1 text-[11px] font-semibold text-white transition hover:bg-brand-500 hover:text-ink disabled:opacity-40"
      >
        Criar
      </button>
      <button
        type="button"
        onClick={close}
        aria-label="Cancelar nova etiqueta"
        className="rounded-full px-2 text-neutral-500 transition hover:bg-band hover:text-ink"
      >
        ×
      </button>
    </form>
  );
}
