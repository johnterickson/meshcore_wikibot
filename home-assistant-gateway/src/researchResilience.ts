export const publicResearchFailureMessage = "Research was interrupted before completion. Please try again; the service is still running.";

export function isTransientModelError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /engine protocol|predict request failed|fetch failed|terminated|model unloaded|econnreset|econnrefused|socket|network/i.test(message);
}