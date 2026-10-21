import { ApiErrorSchema } from "@taskflow/shared";
import { ApiError, NetworkError } from "./BoardRepository.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/**
 * Requisição JSON à nossa API. Converte falhas em NetworkError (vale tentar de
 * novo) ou ApiError (o servidor respondeu com erro). A resposta volta como
 * `unknown`: quem chama valida com o schema de @taskflow/shared.
 */
export async function requestJson(baseUrl: string, method: HttpMethod, path: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    // fetch só rejeita quando nem chegou a ter resposta: rede.
    throw new NetworkError(cause);
  }

  if (response.status === 204) return null;
  const data: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    // Proxy (NGINX ou Vite) responde 502/503/504 quando a API está fora do ar: trata como rede.
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      throw new NetworkError(new Error(`HTTP ${response.status}`));
    }
    const parsed = ApiErrorSchema.safeParse(data);
    throw new ApiError(response.status, parsed.success ? parsed.data.error : `HTTP ${response.status}`);
  }
  return data;
}
