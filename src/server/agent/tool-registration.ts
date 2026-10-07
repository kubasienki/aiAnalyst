import "server-only";
import { z } from "zod";
import type { RegisteredTool, ToolDefinition } from "./contracts";

export function registerTool<TArguments, TContext, TOutcome, TArtifact = never>(
  definition: ToolDefinition<TArguments, TContext, TOutcome, TArtifact>,
): RegisteredTool<TContext, TOutcome, TArtifact> {
  return {
    name: definition.name,
    description: definition.description,
    role: definition.role,
    parameters: z.toJSONSchema(definition.argumentsSchema, { target: "draft-07" }),
    isAvailable: definition.isAvailable,
    async execute(argumentsValue, context) {
      const argumentsResult = definition.argumentsSchema.safeParse(argumentsValue);
      if (!argumentsResult.success) {
        return {
          kind: "error",
          error: {
            code: "invalid_arguments",
            message: "Arguments must match the advertised tool schema. Repair the listed fields using their schema definitions.",
            // Report bounded field paths and categories, never submitted values.
            details: {
              issues: argumentsResult.error.issues.slice(0, 8).map(issue => ({
                field: issue.path.map(part => String(part)).join(".").slice(0, 200) || "arguments",
                code: issue.code,
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
