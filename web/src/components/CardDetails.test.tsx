import { BoardSnapshotSchema, ColumnSchema, DESCRIPTION_LIMIT } from "@taskflow/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBoardStore } from "../store/boardStore.ts";
import { CardDetails } from "./CardDetails.tsx";

const snapshot = BoardSnapshotSchema.pick({ columns: true, cards: true, tags: true }).parse({
  columns: [{ id: "00000000-0000-4000-8000-000000000001", title: "A Fazer", position: 1000 }],
  tags: [{ id: "00000000-0000-4000-8000-000000000002", name: "Urgente", color: "yellow" }],
  cards: [{
    id: "00000000-0000-4000-8000-000000000003",
    columnId: "00000000-0000-4000-8000-000000000001",
    title: "Estudar React", description: "Revisar os hooks", observation: "Notas da tarefa", tagIds: [], position: 1000,
    createdAt: "2026-01-02T12:00:00Z", updatedAt: "2026-02-03T15:30:00Z",
  }],
});
const card = snapshot.cards[0]!;

beforeEach(() => {
  localStorage.clear();
  useBoardStore.getState().hydrate(snapshot);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("detalhes do cartão", () => {
  it("abre com título, descrição, observação, coluna e datas em português", () => {
    render(<CardDetails id={card.id} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog")).toHaveAttribute("open");
    expect(screen.getByLabelText("Título do cartão")).toHaveValue(card.title);
    expect(screen.getByLabelText("Descrição")).toHaveValue(card.description);
    expect(screen.getByLabelText("Descrição")).toHaveAttribute("maxlength", String(DESCRIPTION_LIMIT));
    expect(screen.getByLabelText("Observação")).toHaveValue(card.observation);
    expect(screen.getByLabelText("Observação")).not.toHaveAttribute("maxlength");
    expect(screen.getByText("Na coluna A Fazer")).toBeInTheDocument();
    const format = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
    expect(screen.getByText(`Criado em ${format.format(new Date(card.createdAt))} · Atualizado em ${format.format(new Date(card.updatedAt))}`)).toBeInTheDocument();
  });

  it("salva o título no blur e ignora título só com espaços", () => {
    render(<CardDetails id={card.id} onClose={vi.fn()} />);
    const input = screen.getByLabelText("Título do cartão");
    fireEvent.change(input, { target: { value: "Novo título" } });
    expect(useBoardStore.getState().cards[card.id]?.title).toBe(card.title);
    fireEvent.blur(input);
    expect(useBoardStore.getState().cards[card.id]?.title).toBe("Novo título");
    const saved = useBoardStore.getState().cards[card.id];
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(useBoardStore.getState().cards[card.id]).toBe(saved);
  });

  it("Enter tira o foco do título e salva", () => {
    render(<CardDetails id={card.id} onClose={vi.fn()} />);
    const input = screen.getByLabelText("Título do cartão");
    input.focus();
    fireEvent.change(input, { target: { value: "Título via Enter" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).not.toHaveFocus();
    expect(useBoardStore.getState().cards[card.id]?.title).toBe("Título via Enter");
  });

  it.each(["button", "cancel", "backdrop"])("salva descrição e chama onClose ao fechar por %s", (method) => {
    const onClose = vi.fn();
    render(<CardDetails id={card.id} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("Descrição"), { target: { value: "Descrição editada" } });
    expect(useBoardStore.getState().cards[card.id]?.description).toBe(card.description);
    if (method === "button") fireEvent.click(screen.getByRole("button", { name: "Fechar detalhes" }));
    if (method === "backdrop") fireEvent.click(screen.getByRole("dialog"));
    if (method === "cancel") {
      const event = new Event("cancel", { bubbles: true, cancelable: true });
      fireEvent(screen.getByRole("dialog"), event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(useBoardStore.getState().cards[card.id]?.description).toBe("Descrição editada");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clique dentro do conteúdo não fecha e blur salva descrição vazia como null", () => {
    const onClose = vi.fn();
    render(<CardDetails id={card.id} onClose={onClose} />);
    fireEvent.click(screen.getByText("Na coluna A Fazer"));
    expect(onClose).not.toHaveBeenCalled();
    const input = screen.getByLabelText("Descrição");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(useBoardStore.getState().cards[card.id]?.description).toBeNull();
  });

  it("salva observação longa sem afetar a descrição curta", () => {
    render(<CardDetails id={card.id} onClose={vi.fn()} />);
    const notes = "Anotações detalhadas ".repeat(300);
    const input = screen.getByLabelText("Observação");
    fireEvent.change(input, { target: { value: notes } });
    fireEvent.blur(input);
    expect(useBoardStore.getState().cards[card.id]?.observation).toBe(notes.trim());
    expect(useBoardStore.getState().cards[card.id]?.description).toBe(card.description);
  });

  it.each([true, false])("exclui apenas com confirmação %s", (accepted) => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(accepted);
    const onClose = vi.fn();
    render(<CardDetails id={card.id} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Excluir cartão" }));
    expect(confirm).toHaveBeenCalledWith(`Excluir o cartão "${card.title}"?`);
    if (accepted) {
      expect(useBoardStore.getState().cards[card.id]).toBeUndefined();
      expect(useBoardStore.getState().cardOrder[card.columnId]).toEqual([]);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    } else {
      expect(useBoardStore.getState().cards[card.id]).toEqual(card);
      expect(onClose).not.toHaveBeenCalled();
    }
  });

  it("define, sinaliza atraso e remove a data de entrega", () => {
    const done = ColumnSchema.parse({ id: "00000000-0000-4000-8000-000000000009", title: "Feito", position: 2000 });
    useBoardStore.getState().hydrate({ ...snapshot, columns: [...snapshot.columns, done] });
    render(<CardDetails id={card.id} onClose={vi.fn()} />);
    const input = screen.getByLabelText("Data de entrega");
    expect(input).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Remover data" })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "2999-12-31" } });
    expect(useBoardStore.getState().cards[card.id]?.dueDate).toBe("2999-12-31");
    expect(screen.queryByText("Atrasado")).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "2020-01-15" } });
    expect(screen.getByText("Atrasado")).toBeInTheDocument();
    expect(input).toHaveClass("border-red-600");

    fireEvent.click(screen.getByRole("button", { name: "Remover data" }));
    expect(useBoardStore.getState().cards[card.id]?.dueDate).toBeNull();
    expect(input).toHaveValue("");
    expect(screen.queryByText("Atrasado")).not.toBeInTheDocument();
  });

  it("fecha se o cartão não existe", () => {
    useBoardStore.getState().hydrate({ ...snapshot, cards: [] });
    const onClose = vi.fn();
    const { container } = render(<CardDetails id={card.id} onClose={onClose} />);
    expect(container).toBeEmptyDOMElement();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
