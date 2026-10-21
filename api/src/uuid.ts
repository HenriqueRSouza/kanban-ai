import { createHash } from "node:crypto";

/** Namespace próprio para os IDs dos cartões criados pelo Agente de IA. */
export const AI_CARD_NAMESPACE = "7f1c2a4e-6b1d-4f8e-9a53-3c2d5e8b4a10";

/**
 * UUID versão 5 (RFC 9562): o mesmo nome no mesmo namespace gera sempre o mesmo
 * ID. Com `uuidV5(jobId:índice)`, reaplicar um resultado entregue duas vezes pelo
 * RabbitMQ não cria cartões duplicados.
 */
export function uuidV5(name: string, namespace: string): string {
  const namespaceBytes = Buffer.from(namespace.replaceAll("-", ""), "hex");
  if (namespaceBytes.length !== 16) throw new Error("Namespace UUID inválido");
  const hash = createHash("sha1").update(namespaceBytes).update(name, "utf8").digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
