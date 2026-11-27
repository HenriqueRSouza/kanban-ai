import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { DESCRIPTION_LIMIT, TITLE_LIMITS } from "@taskflow/shared";
import type { CardId } from "@taskflow/shared";
import { isOverdue } from "../lib/dueDate.ts";
import { useBoardStore, useCard, useIsInLastColumn } from "../store/boardStore.ts";
import { CardHistory } from "./CardHistory.tsx";
import { TagPicker } from "./TagPicker.tsx";

const dateFormat = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

/**
 * Painel de detalhes do cartão: título, descrição curta, observação, etiquetas e datas.
 *
 * Usa o <dialog> nativo do HTML aberto com showModal(), que já entrega:
 * foco preso dentro do painel, Esc para fechar e o resto da página inerte.
 */
export function CardDetails({ id, onClose }: { id: CardId; onClose: () => void }) {
  const card = useCard(id);
  const columnTitle = useBoardStore((s) => (card ? s.columns[card.columnId]?.title : undefined));
  const updateCard = useBoardStore((s) => s.updateCard);
  const removeCard = useBoardStore((s) => s.removeCard);
  const isDone = useIsInLastColumn(card?.columnId);

  // Rascunhos locais: digitar não altera o store (nem dispara envio ao servidor)
  // a cada tecla; só ao sair do campo ou fechar o painel.
  const [title, setTitle] = useState(card?.title ?? "");
  const [description, setDescription] = useState(card?.description ?? "");
  const [observation, setObservation] = useState(card?.observation ?? "");

  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLInputElement>(null);
  const observationRef = useRef<HTMLTextAreaElement>(null);

  // O cartão mudou por fora (outra aba, servidor) enquanto o painel está aberto:
  // atualiza o rascunho — a não ser que o usuário esteja digitando naquele campo.
  const storedTitle = card?.title;
  const storedDescription = card?.description;
  const storedObservation = card?.observation;
  useEffect(() => {
    if (storedTitle !== undefined && document.activeElement !== titleRef.current) setTitle(storedTitle);
  }, [storedTitle]);
  useEffect(() => {
    if (document.activeElement !== descriptionRef.current) setDescription(storedDescription ?? "");
  }, [storedDescription]);
  useEffect(() => {
    if (document.activeElement !== observationRef.current) setObservation(storedObservation ?? "");
  }, [storedObservation]);

  // Abre o <dialog> como modal assim que ele existe no DOM; fecha ao desmontar.
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  // Se o cartão deixou de existir (excluído aqui ou por outra aba), fecha o painel.
  useEffect(() => {
    if (!card) onClose();
  }, [card, onClose]);

  if (!card) return null;
  const overdue = card.dueDate !== null && !isDone && isOverdue(card.dueDate);

  function save() {
    if (!card) return;
    const changes: { title?: string; description?: string | null; observation?: string | null } = {};
    if (title.trim() && title.trim() !== card.title) changes.title = title;
    if ((description.trim() || null) !== card.description) changes.description = description;
    if ((observation.trim() || null) !== card.observation) changes.observation = observation;
    if (Object.keys(changes).length > 0) updateCard(id, changes);
  }

  function close() {
    save();
    onClose();
  }

  // Clique no fundo escurecido (fora da caixa) fecha. O alvo é o próprio <dialog>
  // só quando o clique acontece fora do conteúdo interno.
  function handleBackdropClick(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === event.currentTarget) close();
  }

  function handleDelete() {
    if (window.confirm(`Excluir o cartão "${card?.title}"?`)) removeCard(id);
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="card-details-title"
      // onCancel = Esc. preventDefault para fechar pelo nosso close(), que salva antes.
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={handleBackdropClick}
      className="m-auto max-h-[90dvh] w-[min(100%-2rem,34rem)] overflow-y-auto rounded-3xl bg-white p-0 text-ink shadow-2xl backdrop:bg-ink/60 max-sm:mb-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none"
    >
      <div className="space-y-5 p-5 sm:p-6">
        <header className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-neutral-500">Na coluna {columnTitle ?? "—"}</p>
            <h2 id="card-details-title" className="sr-only">
              Detalhes do cartão
            </h2>
            <input
              ref={titleRef}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={save}
              onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
              maxLength={TITLE_LIMITS.card}
              aria-label="Título do cartão"
              className="mt-1 w-full rounded-lg border border-transparent px-1 py-1 font-display text-xl font-extrabold tracking-tight hover:border-neutral-200 focus:border-ink focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Fechar detalhes"
            className="rounded-full px-3 py-1 text-xl text-neutral-500 transition hover:bg-band hover:text-ink"
          >
            ×
          </button>
        </header>

        <section className="space-y-2">
          <label htmlFor="card-description" className="text-sm font-semibold">
            Descrição
          </label>
          <input
            ref={descriptionRef}
            id="card-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            onBlur={save}
            maxLength={DESCRIPTION_LIMIT}
            placeholder="Resumo breve da tarefa…"
            className="w-full rounded-xl border border-neutral-300 bg-tile px-3 py-2 text-sm focus:border-ink focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <p className="text-right text-xs text-neutral-500">{description.length}/{DESCRIPTION_LIMIT} caracteres</p>
        </section>

        <section className="space-y-2">
          <label htmlFor="card-observation" className="text-sm font-semibold">
            Observação
          </label>
          <textarea
            ref={observationRef}
            id="card-observation"
            value={observation}
            onChange={(event) => setObservation(event.target.value)}
            onBlur={save}
            rows={5}
            placeholder="Adicione detalhes e anotações sobre esta tarefa…"
            className="w-full resize-y rounded-xl border border-neutral-300 bg-tile px-3 py-2 text-sm leading-relaxed focus:border-ink focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </section>

        <section className="space-y-2">
          <label htmlFor="card-due-date" className="text-sm font-semibold">
            Data de entrega
          </label>
          <div className="flex flex-wrap items-center gap-2">
            {/* Salva na hora: o seletor de data não tem "digitação" a cada tecla. */}
            <input
              id="card-due-date"
              type="date"
              value={card.dueDate ?? ""}
              onChange={(event) => updateCard(id, { dueDate: event.target.value || null })}
              aria-describedby={overdue ? "card-due-date-status" : undefined}
              className={`rounded-xl border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 ${
                overdue ? "border-red-600 bg-red-50 text-red-700" : "border-neutral-300 bg-tile focus:border-ink focus:bg-white"
              }`}
            />
            {overdue && (
              <span id="card-due-date-status" className="rounded-full bg-red-600 px-2.5 py-1 text-xs font-semibold text-white">
                Atrasado
              </span>
            )}
            {card.dueDate && (
              <button
                type="button"
                onClick={() => updateCard(id, { dueDate: null })}
                className="rounded-full px-3 py-1 text-sm text-neutral-500 transition hover:bg-band hover:text-ink"
              >
                Remover data
              </button>
            )}
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Etiquetas</h3>
          <TagPicker cardId={id} />
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Histórico</h3>
          <CardHistory cardId={id} />
        </section>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-200 pt-4 text-xs text-neutral-500">
          <p>
            Criado em {dateFormat.format(new Date(card.createdAt))} · Atualizado em{" "}
            {dateFormat.format(new Date(card.updatedAt))}
          </p>
          <button
            type="button"
            onClick={handleDelete}
            className="rounded-full border border-red-200 px-4 py-2 font-semibold text-red-700 transition hover:bg-red-50"
          >
            Excluir cartão
          </button>
        </footer>
      </div>
    </dialog>
  );
}
