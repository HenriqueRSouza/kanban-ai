import { describe, expect, it } from "vitest";
import { formatDueDate, isOverdue, localIsoDate } from "./dueDate.ts";

describe("data de entrega", () => {
  it("usa a data LOCAL, não a UTC", () => {
    expect(localIsoDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });

  it("só fica atrasado depois do dia do prazo", () => {
    expect(isOverdue("2026-10-07", "2026-10-08")).toBe(true);
    expect(isOverdue("2026-10-08", "2026-10-08")).toBe(false);
    expect(isOverdue("2026-10-09", "2026-10-08")).toBe(false);
  });

  it("omite o ano corrente e mostra os outros", () => {
    expect(formatDueDate("2026-10-09", "2026-10-08")).toBe("09/10");
    expect(formatDueDate("2027-01-02", "2026-10-08")).toBe("02/01/2027");
  });
});
