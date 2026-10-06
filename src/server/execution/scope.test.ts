import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionScope } from "./scope";

afterEach(() => vi.useRealTimers());

describe("execution scope", () => {
  it("keeps an expired scope stopped if the wall clock moves backwards", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const scope = createExecutionScope(new AbortController().signal, startedAt + 20);
    try {
      await vi.advanceTimersByTimeAsync(20);
      vi.setSystemTime(startedAt);
      expect(scope.signal.aborted).toBe(true);
      expect(scope.check).toThrowError(expect.objectContaining({ reason: "deadline" }));
      await expect(scope.wait(Promise.resolve("late success"))).rejects.toMatchObject({ reason: "deadline" });
    } finally {
      scope.dispose();
    }
  });
});
