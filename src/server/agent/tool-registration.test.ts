import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerTool } from "./tool-registration";

describe("tool argument feedback", () => {
  it("reports bounded field paths and categories without submitted values", async () => {
    const handle = vi.fn();
    const tool = registerTool({
      name: "example",
      description: "Example tool",
      role: "terminal",
      argumentsSchema: z.strictObject({ fields: z.array(z.number()) }),
      handle,
    });
    const result = await tool.execute({ fields: Array(12).fill("private submitted value") }, {
      applicationContext: {},
      canContinue: true,
      signal: new AbortController().signal,
      deadline: Date.now() + 1_000,
      checkContinuation() {},
    });

    expect(result).toMatchObject({
      kind: "error",
      error: {
        code: "invalid_arguments",
        details: {
          issues: Array.from({ length: 8 }, (_, index) => ({
            field: `fields.${index}`,
            code: "invalid_type",
            expected: expect.stringContaining("expected number"),
          })),
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("private submitted value");
    expect(handle).not.toHaveBeenCalled();
  });
});
