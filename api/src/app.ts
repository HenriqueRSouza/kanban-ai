import cors from "cors";
import express from "express";
import type { ErrorRequestHandler } from "express";
import { HttpError, mapPostgresError } from "./http.ts";
import { createAiJobsRouter } from "./routes/ai-jobs.ts";
import { boardRouter } from "./routes/board.ts";
import { cardsRouter } from "./routes/cards.ts";
import { columnsRouter } from "./routes/columns.ts";
import { tagsRouter } from "./routes/tags.ts";

export interface AppOptions {
  /** Chamado quando um job do Agente de IA é criado, para publicá-lo sem esperar a próxima varredura. */
  onAiJobCreated?: () => void;
}

export function createApp(options: AppOptions = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use("/api", boardRouter);
  app.use("/api/columns", columnsRouter);
  app.use("/api/cards", cardsRouter);
  app.use("/api/tags", tagsRouter);
  app.use("/api/ai/jobs", createAiJobsRouter(options.onAiJobCreated ?? (() => undefined)));
  app.use((_req, res) => {
    res.status(404).json({ error: "Rota não encontrada" });
  });

  const handleError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    error = mapPostgresError(error);
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof SyntaxError && "status" in error && error.status === 400) {
      res.status(400).json({ error: "JSON inválido" });
      return;
    }
    console.error(error);
    res.status(500).json({ error: "Erro interno do servidor" });
  };
  app.use(handleError);
  return app;
}
