import { BoardSnapshotSchema, CardHistorySchema } from "@taskflow/shared";
import type { BoardSnapshot, Card, CardEvent, CardId, Column, ColumnId, Tag, TagId } from "@taskflow/shared";
import type { BoardRepository } from "./BoardRepository.ts";
import { requestJson, type HttpMethod } from "./http.ts";

/** Implementação do repositório que conversa com a nossa API REST. */
export class HttpBoardRepository implements BoardRepository {
  private readonly baseUrl: string;

  constructor(baseUrl = "/api") {
    this.baseUrl = baseUrl;
  }

  async fetchBoard(): Promise<BoardSnapshot> {
    // Resposta da API é dado externo: valida antes de entregar ao app.
    return BoardSnapshotSchema.parse(await this.request("GET", "/board"));
  }

  async upsertColumn({ id, title, position }: Column): Promise<void> {
    await this.request("PUT", `/columns/${id}`, { title, position });
  }

  async deleteColumn(id: ColumnId): Promise<void> {
    await this.request("DELETE", `/columns/${id}`);
  }

  async upsertCard({ id, ...card }: Card): Promise<void> {
    // Envia também createdAt/updatedAt: o banco registra o histórico com a hora
    // em que a ação aconteceu no aparelho (mesmo que tenha sido offline).
    await this.request("PUT", `/cards/${id}`, card);
  }

  async deleteCard(id: CardId): Promise<void> {
    await this.request("DELETE", `/cards/${id}`);
  }

  async upsertTag({ id, name, color }: Tag): Promise<void> {
    await this.request("PUT", `/tags/${id}`, { name, color });
  }

  async deleteTag(id: TagId): Promise<void> {
    await this.request("DELETE", `/tags/${id}`);
  }

  async fetchCardHistory(id: CardId): Promise<CardEvent[]> {
    return CardHistorySchema.parse(await this.request("GET", `/cards/${id}/history`));
  }

  private request(method: HttpMethod, path: string, body?: unknown): Promise<unknown> {
    return requestJson(this.baseUrl, method, path, body);
  }
}
