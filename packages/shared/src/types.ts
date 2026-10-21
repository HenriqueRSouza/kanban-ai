import type { z } from "zod";
import type {
  BoardIdSchema,
  BoardSnapshotSchema,
  CardEventSchema,
  CardIdSchema,
  CardSchema,
  ColumnIdSchema,
  ColumnSchema,
  TagColorSchema,
  TagIdSchema,
  TagSchema,
  UpsertCardSchema,
  UpsertColumnSchema,
  UpsertTagSchema,
} from "./schemas.ts";
import type {
  AiJobEventSchema,
  AiJobIdSchema,
  AiJobSchema,
  AiJobStatusSchema,
  CreateAiJobSchema,
  GenerateCardsCommandSchema,
  GeneratedCardSchema,
  LlmProviderSchema,
} from "./messages.ts";

export type BoardId = z.infer<typeof BoardIdSchema>;
export type ColumnId = z.infer<typeof ColumnIdSchema>;
export type CardId = z.infer<typeof CardIdSchema>;
export type TagId = z.infer<typeof TagIdSchema>;

export type TagColor = z.infer<typeof TagColorSchema>;
export type Tag = z.infer<typeof TagSchema>;
export type Column = z.infer<typeof ColumnSchema>;
export type Card = z.infer<typeof CardSchema>;
export type BoardSnapshot = z.infer<typeof BoardSnapshotSchema>;
export type CardEvent = z.infer<typeof CardEventSchema>;

export type UpsertColumnInput = z.infer<typeof UpsertColumnSchema>;
export type UpsertCardInput = z.infer<typeof UpsertCardSchema>;
export type UpsertTagInput = z.infer<typeof UpsertTagSchema>;

/** Estado de sincronização de um item com a API — união discriminada. */
export type SyncState =
  | { status: "synced" }
  | { status: "pending"; since: string }
  | { status: "error"; message: string };

export type AiJobId = z.infer<typeof AiJobIdSchema>;
export type AiJobStatus = z.infer<typeof AiJobStatusSchema>;
export type AiJob = z.infer<typeof AiJobSchema>;
export type CreateAiJobInput = z.infer<typeof CreateAiJobSchema>;
export type GeneratedCard = z.infer<typeof GeneratedCardSchema>;
export type GenerateCardsCommand = z.infer<typeof GenerateCardsCommandSchema>;
export type AiJobEvent = z.infer<typeof AiJobEventSchema>;
export type LlmProvider = z.infer<typeof LlmProviderSchema>;
