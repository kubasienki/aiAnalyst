import "server-only";
import { z } from "zod";
import type { RegisteredTool, ToolDefinition, ToolDescription } from "./contracts";

// The only place a tool's advertised schema is derived. Callers that must
// advertise tools before they can be constructed project them through here, so
// the registered tool and the advertised description cannot disagree.
export function describeTool(
  name: string,
  description: string,
  argumentsSchema: z.ZodType<unknown>,
): ToolDescription {
  return { name, description, parameters: z.toJSONSchema(argumentsSchema, { target: "draft-07" }) };
}

export function registerTool<TArguments, TContext, TOutcome, TArtifact = never>(
  definition: ToolDefinition<TArguments, TContext, TOutcome, TArtifact>,
): RegisteredTool<TContext, TOutcome, TArtifact> {
  return {
    ...describeTool(definition.name, definition.description, definition.argumentsSchema),
    role: definition.role,
    isAvailable: definition.isAvailable,
    async execute(argumentsValue, context) {
      const argumentsResult = definition.argumentsSchema.safeParse(argumentsValue);
      if (!argumentsResult.success) {
        return {
          kind: "error",
          error: {
            code: "invalid_arguments",
            message: "Arguments must match the advertised tool schema. Repair the listed fields using their schema definitions.",
            // Report bounded field paths, categories and schema expectations, never
            // submitted values. Without the expectation (e.g. the allowed enum values)
            // models were observed resubmitting the same invalid call until the budget ran out.
            details: {
              issues: argumentsResult.error.issues.slice(0, 8).map(issue => ({
                field: issue.path.map(part => String(part)).join(".").slice(0, 200) || "arguments",
                code: issue.code,
                expected: issue.message.slice(0, 200),
              })),
            },
          },
          repeatPolicy: "unchanged_arguments",
        };
      }
      // Handler exceptions are not argument errors or implicit repair attempts.
      return definition.handle(argumentsResult.data, context);
    },
  };
}
