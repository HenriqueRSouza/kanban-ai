import { useEffect, useRef, useState } from "react";
import type { FormEvent, MouseEvent } from "react";
import { AI_DEFAULT_MAX_CARDS, AI_INPUT_LIMITS, AI_MAX_CARDS_LIMIT, CreateAiJobSchema } from "@taskflow/shared";
import { ApiError, NetworkError } from "../data/BoardRepository.ts";
import { useBoardStore, useColumnOrder } from "../store/boardStore.ts";
import { submitAiJob, useAiJobsStore } from "../store/aiJobsStore.ts";
import { AiJobItem } from "./AiJobItem.tsx";

const CARD_OPTIONS = Array.from({ length: AI_MAX_CARDS_LIMIT }, (_, index) => index + 1);

function describeError(error: unknown): string {
  if (error instanceof NetworkError) return "Sem conexão com o servidor. Tente de novo: o pedido não será duplicado.";
  if (error instanceof ApiError) return error.message;
  return "Não foi possível enviar o pedido.";
}

/**
 * Painel do Agente de IA: o usuário cola uma user story ou um planejamento e
 * escolhe a coluna. O pedido vai para a fila (RabbitMQ) e os cartões aparecem
 * no quadro quando o worker termina; a lista abaixo mostra o andamento.
 */
export function AiAgentDialog({ onClose }: { onClose: () => void }) {
  const columnOrder = useColumnOrder();
  const columns = useBoardStore((s) => s.columns);
  const jobs = useAiJobsStore((s) => s.jobs);

  const [input, setInput] = useState("");
  const [targetColumnId, setTargetColumnId] = useState<string>(columnOrder[0] ?? "");
  const [maxCards, setMaxCards] = useState<number>(AI_DEFAULT_MAX_CARDS);
  // A mesma chave é reenviada após uma falha de rede; só muda depois de um envio aceito.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  // A coluna escolhida foi excluída enquanto o painel estava aberto: volta para a primeira.
  useEffect(() => {
    if (!columnOrder.some((id) => id === targetColumnId)) setTargetColumnId(columnOrder[0] ?? "");
  }, [columnOrder, targetColumnId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = CreateAiJobSchema.safeParse({ input, targetColumnId, idempotencyKey, maxCards });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Pedido inválido");
      return;
    }
    setSending(true);
    setError(null);
    try {
      await submitAiJob(parsed.data);
      setInput("");
      setIdempotencyKey(crypto.randomUUID());
    } catch (submitError) {
      setError(describeError(submitError));
    } finally {
      setSending(false);
    }
  }

  function handleBackdropClick(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === event.currentTarget) onClose();
  }

  const length = input.trim().length;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="ai-agent-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={handleBackdropClick}
      className="m-auto max-h-[90dvh] w-[min(100%-2rem,38rem)] overflow-y-auto rounded-3xl bg-white p-0 text-ink shadow-2xl backdrop:bg-ink/60 max-sm:mb-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none"
    >
      <div className="space-y-5 p-5 sm:p-6">
        <header className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 id="ai-agent-title" className="font-display text-xl font-extrabold tracking-tight">
              Agente de IA
            </h2>
            <p className="mt-1 text-sm text-neutral-600">
              Cole uma user story ou o planejamento do projeto. O agente quebra o texto em tarefas e cria os cartões.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="rounded-full px-3 py-1 text-lg text-neutral-500 transition hover:bg-tile hover:text-ink"
          >
            ×
          </button>
        </header>

        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-3">
          <div className="space-y-1">
            <label htmlFor="ai-agent-input" className="block text-xs font-semibold text-neutral-600">
              Texto
            </label>
            <textarea
              id="ai-agent-input"
              aria-describedby="ai-agent-input-count"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              rows={6}
              maxLength={AI_INPUT_LIMITS.max}
              placeholder="Como aluno, quero exportar o quadro em PDF para compartilhar com o grupo…"
              className="w-full resize-y rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-ink focus:ring-2 focus:ring-brand-500"
            />
            <p id="ai-agent-input-count" className="text-right text-xs text-neutral-500">
              {length}/{AI_INPUT_LIMITS.max} caracteres
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <label className="min-w-40 flex-1 space-y-1">
              <span className="text-xs font-semibold text-neutral-600">Criar na coluna</span>
              <select
                value={targetColumnId}
                onChange={(event) => setTargetColumnId(event.target.value)}
                className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-ink focus:ring-2 focus:ring-brand-500"
              >
                {columnOrder.map((id) => (
                  <option key={id} value={id}>
                    {columns[id]?.title ?? "—"}
                  </option>
                ))}
              </select>
            </label>
            <label className="w-32 space-y-1">
              <span className="text-xs font-semibold text-neutral-600">Até</span>
              <select
                value={maxCards}
                onChange={(event) => setMaxCards(Number(event.target.value))}
                className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-ink focus:ring-2 focus:ring-brand-500"
              >
                {CARD_OPTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value} {value === 1 ? "cartão" : "cartões"}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {error && (
            <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-800">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-neutral-500">O texto é processado pelo provedor de IA configurado no servidor.</p>
            <button
              type="submit"
              disabled={sending || columnOrder.length === 0}
              className="rounded-full bg-ink px-5 py-2 text-sm font-semibold text-white transition hover:bg-brand-500 hover:text-ink disabled:opacity-40"
            >
              {sending ? "Enviando…" : "Gerar cartões"}
            </button>
          </div>
        </form>

        {jobs.length > 0 && (
          <section aria-labelledby="ai-jobs-title" className="space-y-2">
            <h3 id="ai-jobs-title" className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Pedidos recentes
            </h3>
            <ul aria-live="polite" className="space-y-2">
              {jobs.map((job) => (
                <AiJobItem key={job.id} job={job} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </dialog>
  );
}
