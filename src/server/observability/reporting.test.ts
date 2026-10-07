import { afterEach, describe, expect, it, vi } from "vitest";
import { captureTrace, reportSafely, TRACE_WAIT_MS } from "./reporting";

afterEach(() => vi.useRealTimers());

describe("best-effort observability", () => {
  it.each(["throw", "reject"])("isolates a trace callback that %ss and a throwing diagnostic reporter", async failure => {
    const report = vi.fn(() => { throw new Error("reporter unavailable"); });
    await expect(captureTrace({
      signal: new AbortController().signal,
      deadline: Date.now() + 1000,
      reportFailure: report,
      write() {
        if (failure === "throw") {
          throw new Error("private trace payload");
        }
        return Promise.reject(new Error("private trace payload"));
      },
    })).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledWith("trace_failed");
  });

  it("bounds stalled capture, aborts late writers, and consumes late rejection", async () => {
    vi.useFakeTimers();
    const report = vi.fn();
    let rejectLate: (error: Error) => void = () => {};
    const late = new Promise<void>((_resolve, reject) => { rejectLate = reject; });
    let writerSignal = new AbortController().signal;
    const capture = captureTrace({
      signal: new AbortController().signal,
      deadline: Date.now() + 1000,
      reportFailure: report,
      write(signal) {
        writerSignal = signal;
        return late;
      },
    });
    await vi.advanceTimersByTimeAsync(TRACE_WAIT_MS);
    await capture;
    expect(writerSignal.aborted).toBe(true);
    expect(report).toHaveBeenCalledExactlyOnceWith("trace_timeout");
    expect(vi.getTimerCount()).toBe(0);
    rejectLate(new Error("late private rejection"));
    await Promise.resolve();
  });

  it("uses the remaining run budget and skips writers after cancellation or expiry", async () => {
    vi.useFakeTimers();
    const cancellation = new AbortController();
    const write = vi.fn(() => new Promise<void>(() => {}));
    const capture = captureTrace({ signal: cancellation.signal, deadline: Date.now() + 10, write });
    await vi.advanceTimersByTimeAsync(10);
    await capture;
    expect(vi.getTimerCount()).toBe(0);
    cancellation.abort();
    await captureTrace({ signal: cancellation.signal, deadline: Date.now() + 1000, write });
    await captureTrace({ signal: new AbortController().signal, deadline: Date.now(), write });
    expect(write).toHaveBeenCalledOnce();
  });

  it("invalidates the writer signal after successful capture and protects reporting", async () => {
    let writerSignal = new AbortController().signal;
    await captureTrace({
      signal: new AbortController().signal,
      deadline: Date.now() + 1000,
      async write(signal) { writerSignal = signal; },
    });
    expect(writerSignal.aborted).toBe(true);
    expect(() => reportSafely(() => { throw new Error("sink"); }, "category")).not.toThrow();
  });
});
