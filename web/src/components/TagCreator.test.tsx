import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useBoardStore } from "../store/boardStore.ts";
import { TagCreator } from "./TagCreator.tsx";

beforeEach(() => {
  localStorage.clear();
  useBoardStore.getState().hydrate({ columns: [], cards: [], tags: [] });
});
afterEach(cleanup);

describe("criador de etiquetas", () => {
  it("abre pelo botão, cria etiqueta vermelha e volta a ficar recolhido", () => {
    render(<TagCreator />);
    fireEvent.click(screen.getByRole("button", { name: "+ Etiqueta" }));
    const input = screen.getByRole("textbox", { name: "Nome da nova etiqueta" });
    const submit = screen.getByRole("button", { name: "Criar" });
    expect(submit).toBeDisabled();
    fireEvent.change(input, { target: { value: "   " } });
    expect(submit).toBeDisabled();
    fireEvent.change(input, { target: { value: "Revisão" } });
    fireEvent.click(screen.getByRole("radio", { name: "Vermelho" }));
    expect(screen.getByRole("radio", { name: "Vermelho" })).toBeChecked();
    fireEvent.click(submit);
    expect(Object.values(useBoardStore.getState().tags)).toEqual([
      expect.objectContaining({ name: "Revisão", color: "red" }),
    ]);
    expect(screen.queryByRole("textbox", { name: "Nome da nova etiqueta" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Etiqueta" })).toBeInTheDocument();
  });

  it("Esc e o botão de cancelar fecham sem criar", () => {
    render(<TagCreator />);
    fireEvent.click(screen.getByRole("button", { name: "+ Etiqueta" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Nome da nova etiqueta" }), { target: { value: "Rascunho" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Nome da nova etiqueta" }), { key: "Escape" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "+ Etiqueta" }));
    expect(screen.getByRole("textbox", { name: "Nome da nova etiqueta" })).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar nova etiqueta" }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(useBoardStore.getState().tags).toEqual({});
  });
});
