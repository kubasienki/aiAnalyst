import "server-only";
import { z } from "zod";
import { ModelError } from "../agent/errors";
import type { ModelMessage } from "../agent/contracts";
import { ContextError, type BuildContextInput, type BuiltContext, type ContextBudget, type ContextMeasurement, type ModelRequestMeasurer } from "./contracts";
import { reconstructHistory } from "./history";
import { selectContext } from "./selection";
import { projectContext } from "./projection";
import { measureContextRequest } from "./budget";

export function createContextBuilder(dependencies: { measurer: ModelRequestMeasurer; budget: ContextBudget }) {
  return function buildContext(input: BuildContextInput): BuiltContext {
    const instructions = z.array(z.string().trim().min(1)).min(1).safeParse(input.instructions);
    if (!instructions.success) {
      throw new ContextError("configuration", "Context construction requires nonempty analyst instructions.");
    }
    const history = reconstructHistory(input.history, input.targetRunId);
    const selection = selectContext(history);
    const projection = projectContext(selection, history);
    const messages: ModelMessage[] = [
      ...instructions.data.map(content => ({ role: "system" as const, content })),
      ...projection.messages,
    ];
    let measurement: ContextMeasurement;
    try {
      measurement = measureContextRequest({ ...input.requestSettings, messages }, dependencies.measurer, dependencies.budget);
    } catch (error) {
      if (error instanceof ModelError && error.code === "replay_mismatch") {
        throw new ContextError("replay_mismatch", error.message);
      }
      if (error instanceof ModelError && error.code === "invalid_request") {
        throw new ContextError("configuration", "The prospective model request is invalid.");
      }
      throw error;
    }
    return { ...projection, messages, excludedInteractions: selection.excludedInteractions, measurement };
  };
}
