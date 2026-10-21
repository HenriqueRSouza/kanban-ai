import { hostname } from "node:os";

type LogFields = Record<string, string | number | boolean | null | undefined>;

const instance = hostname();

/** Log estruturado: uma linha JSON por evento, com o correlationId da operação. */
export function log(event: string, fields: LogFields = {}): void {
  if (process.env.VITEST) return;
  console.log(JSON.stringify({ ts: new Date().toISOString(), service: "worker", instance, event, ...fields }));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
