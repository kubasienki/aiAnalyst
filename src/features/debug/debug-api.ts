import { debugRunListSchema, debugRunSchema, type DebugRun, type DebugRunSummary } from "../../shared/agent-debug";

export function createDebugApi(fetcher: typeof fetch = fetch) {
  async function request(url: string, signal: AbortSignal): Promise<unknown> {
    const response = await fetcher(url, { signal, cache: "no-store" });
    if (!response.ok) {
      throw new Error("Could not read local agent data.");
    }
    return response.json();
  }
  return {
    async list(signal: AbortSignal): Promise<DebugRunSummary[]> {
      return debugRunListSchema.parse(await request("/api/debug/agents", signal)).runs;
    },
    async load(runId: string, signal: AbortSignal): Promise<DebugRun> {
      return debugRunSchema.parse(await request(`/api/debug/agents/${runId}`, signal));
    },
  };
}
