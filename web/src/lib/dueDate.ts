/*
 * Datas de entrega são dias do calendário no formato AAAA-MM-DD (sem fuso).
 * Por isso a comparação é feita com o "hoje" LOCAL do aparelho, também como
 * texto AAAA-MM-DD — que, nesse formato, ordena igual às datas.
 */

/** Data local de hoje (ou de `now`) no formato AAAA-MM-DD. */
export function localIsoDate(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Atrasado = o prazo já passou (vencer hoje ainda não é atraso). */
export function isOverdue(dueDate: string, today: string = localIsoDate()): boolean {
  return dueDate < today;
}

/** "09/10" no ano corrente; "09/10/2027" em outro ano. */
export function formatDueDate(dueDate: string, today: string = localIsoDate()): string {
  const [year, month, day] = dueDate.split("-");
  return year === today.slice(0, 4) ? `${day}/${month}` : `${day}/${month}/${year}`;
}
