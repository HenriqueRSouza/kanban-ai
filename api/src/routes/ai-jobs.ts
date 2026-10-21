import { randomUUID } from "node:crypto";
import { AiJobIdSchema, CreateAiJobSchema } from "@taskflow/shared";
import { Router, type Request } from "express";
import { createAiJob, getAiJob } from "../ai-jobs.ts";
import { HttpError, parseBody, parseId } from "../http.ts";
import { log } from "../log.ts";

const REQUEST_ID = /^[A-Za-z0-9._-]{1,200}$/;

/** Usa o X-Request-Id gerado pelo NGINX; sem ele (dev/testes), cria um. */
function correlationIdOf(req: Request): string {
  const header = req.get("x-request-id");
  return header && REQUEST_ID.test(header) ? header : randomUUID();
}

export function createAiJobsRouter(onJobCreated: () => void): Router {
  const router = Router();

  router.post("/", async (req, res) => {
    const body = parseBody(CreateAiJobSchema, req);
    const correlationId = correlationIdOf(req);
    log("http.received", { correlationId, route: "POST /api/ai/jobs" });
    const { job, created } = await createAiJob(body, correlationId);
    if (created) {
      log("job.created", { correlationId, jobId: job.id });
      onJobCreated();
    }
    // 202: o pedido foi aceito, mas os cartões ficam prontos depois (acompanhe pelo GET).
    res.status(created ? 202 : 200).location(`/api/ai/jobs/${job.id}`).json(job);
  });

  router.get("/:id", async (req, res) => {
    const id = parseId(AiJobIdSchema, req.params.id);
    const job = await getAiJob(id);
    if (!job) throw new HttpError(404, "Job não encontrado");
    res.json(job);
  });

  return router;
}
