import { z } from "zod";
import type { DebugTrace } from "../../shared/agent-debug";

export function displayTime(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "—";
  }
  return new Date(value).toLocaleString();
}

export function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

export function recordValue(value: unknown): Record<string, unknown> | null {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  return parsed.success ? parsed.data : null;
}

const usageSchema = z.object({
  usage: z.object({
    inputTokens: z.number().int().nonnegative().safe(),
    outputTokens: z.number().int().nonnegative().safe(),
  }),
});

export function totalReportedTokens(traces: DebugTrace[]): { input: number; output: number } | null {
  let total: { input: number; output: number } | null = null;
  for (const trace of traces) {
    if (trace.kind !== "model_call") {
      continue;
    }
    const parsed = usageSchema.safeParse(trace.payload);
    if (!parsed.success) {
      continue;
    }
    if (total === null) {
      total = { input: 0, output: 0 };
    }
    total.input += parsed.data.usage.inputTokens;
    total.output += parsed.data.usage.outputTokens;
  }
  return total;
}
