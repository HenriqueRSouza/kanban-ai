import { publishPendingJobs, type PublishCommand } from "../ai-jobs.ts";
import { errorMessage, log } from "../log.ts";

export interface Outbox {
  /** Publica o que estiver pendente agora (chamado logo após criar um job). */
  trigger(): Promise<void>;
  /** Varre os pendentes periodicamente: cobre broker fora do ar e API reiniciada. */
  start(): void;
  stop(): Promise<void>;
}

export function createOutbox(publish: PublishCommand, options: { intervalMs?: number; batchSize?: number } = {}): Outbox {
  const intervalMs = options.intervalMs ?? 2000;
  const batchSize = options.batchSize ?? 20;
  let running: Promise<void> | null = null;
  let rerun = false;
  let timer: NodeJS.Timeout | null = null;

  async function drain(): Promise<void> {
    for (;;) {
      const { published, selected, error } = await publishPendingJobs(publish, batchSize);
      for (const command of published) {
        log("msg.published", { correlationId: command.correlationId, jobId: command.jobId, messageId: command.messageId });
      }
      if (error) {
        log("outbox.publish_failed", { error: errorMessage(error), pending: selected - published.length });
        return;
      }
      if (selected < batchSize) return;
    }
  }

  function trigger(): Promise<void> {
    // Um disparo durante uma varredura agenda outra, para não perder o job recém-criado.
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      do {
        rerun = false;
        try {
          await drain();
        } catch (error: unknown) {
          log("outbox.error", { error: errorMessage(error) });
        }
      } while (rerun);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  return {
    trigger,
    start() {
      timer ??= setInterval(() => void trigger(), intervalMs);
      void trigger();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
  };
}
