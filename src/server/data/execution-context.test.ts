import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, withinDeadline } from "./execution-context";

afterEach(() => vi.useRealTimers());

describe("query execution deadlines", () => {
  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid deadline %s", deadline => {
    expect(() => createExecutionContext({ deadline })).toThrowError(expect.objectContaining({ code: "invalid_input" }));
  });

  it("schedules long deadlines in chunks and releases its timer", async () => {
    vi.useFakeTimers();
    const context = createExecutionContext({ deadline: Date.now() + 2_147_483_648 });
    const result = withinDeadline(new Promise<void>(() => {}), context);
    const assertion = expect(result).rejects.toMatchObject({ code: "deadline" });
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["resolve", "reject"])("checks the clock on late %s before delayed timers execute", async settlement => {
    vi.useFakeTimers();
    const context = createExecutionContext({ deadline: Date.now() + 20 });
    let resolveWork: (value: string) => void = () => {};
    let rejectWork: (error: Error) => void = () => {};
    const work = new Promise<string>((resolve, reject) => {
      resolveWork = resolve;
      rejectWork = reject;
    });
    const result = withinDeadline(work, context);
    const assertion = expect(result).rejects.toMatchObject({ code: "deadline" });
    vi.setSystemTime(context.deadline);
    if (settlement === "resolve") {
      resolveWork("late success");
    } else {
      rejectWork(new Error("private provider detail"));
    }
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("consumes rejection after cancellation and removes its timer", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let rejectWork: (error: Error) => void = () => {};
    const work = new Promise<void>((_resolve, reject) => { rejectWork = reject; });
    const result = withinDeadline(work, createExecutionContext({ signal: controller.signal }));
    const assertion = expect(result).rejects.toMatchObject({ code: "cancelled" });
    controller.abort();
    await assertion;
    rejectWork(new Error("late private detail"));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
});
