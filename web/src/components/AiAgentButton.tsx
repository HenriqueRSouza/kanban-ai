import { useState } from "react";
import { isActiveJob, useAiJobsStore } from "../store/aiJobsStore.ts";
import { AiAgentDialog } from "./AiAgentDialog.tsx";

/** Abre o painel do Agente de IA e mostra quantos pedidos estão em andamento. */
export function AiAgentButton() {
  const [open, setOpen] = useState(false);
  const active = useAiJobsStore((s) => s.jobs.filter(isActiveJob).length);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={active > 0 ? `Agente de IA, ${active} em andamento` : "Agente de IA"}
        className="mt-6 inline-flex items-center gap-2 rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-500 hover:text-ink"
      >
        <span aria-hidden="true">✦</span>
        Agente de IA
        {active > 0 && (
          <span aria-hidden="true" className="rounded-full bg-brand-500 px-2 text-xs font-bold text-ink">
            {active}
          </span>
        )}
      </button>
      {open && <AiAgentDialog onClose={() => setOpen(false)} />}
    </>
  );
}
