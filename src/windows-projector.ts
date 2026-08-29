import { detectObsProcessState } from "./obs-launcher";

/**
 * Returns the number of visible OBS projector windows, or null when the
 * platform/probe cannot confirm the state without heavy subprocess spawning.
 */
export async function detectObsPreviewProjectors(): Promise<number | null> {
  if (process.platform !== "win32") return null;

  // Se o OBS nem sequer está em execução, devolve 0 imediatamente em 0ms.
  if (detectObsProcessState() === "notDetected") return 0;

  return null;
}


