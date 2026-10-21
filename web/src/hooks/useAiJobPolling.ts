import { useEffect } from "react";
import { startAiJobPolling } from "../store/aiJobsStore.ts";

/** Acompanha os pedidos do Agente de IA enquanto o App estiver na tela. */
export function useAiJobPolling() {
  useEffect(() => startAiJobPolling(), []);
}
