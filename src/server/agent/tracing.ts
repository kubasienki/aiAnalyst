import "server-only";
import { jsonValueSchema } from "../contracts/json";
import { captureTrace, type TraceFailure } from "../observability/reporting";
import type { ToolCallTrace } from "./contracts";

type ToolTraceCapture = {
  signal: AbortSignal;
  deadline: number;
  record?: (trace: ToolCallTrace, signal: AbortSignal) => Promise<void>;
  reportFailure(category: TraceFailure): void;
};

type ToolExecutionTrace = Omit<ToolCallTrace, "result"> & { result: unknown };

export function createToolTraceRecorder(input: ToolTraceCapture) {
  return async (trace: ToolExecutionTrace): Promise<void> => {
    const record = input.record;
    if (!record) {
      return;
    }
    await captureTrace({
      signal: input.signal,
      deadline: input.deadline,
      reportFailure: input.reportFailure,
      write: signal => record({
        ...trace,
        // Trace serialization is optional too; it cannot veto a checkpoint.
        result: jsonValueSchema.parse(JSON.parse(JSON.stringify(trace.result))),
      }, signal),
    });
  };
}
