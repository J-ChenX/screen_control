import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startVisiblePolling } from "./visiblePolling";

describe("foreground status polling", () => {
  let doc: EventTarget & { visibilityState: string };
  let win: EventTarget;
  let stop: (() => void) | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    win = new EventTarget();
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", win);
  });
  afterEach(() => { stop?.(); stop = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
  const show = (visible: boolean) => { doc.visibilityState = visible ? "visible" : "hidden"; doc.dispatchEvent(new Event("visibilitychange")); };

  it("does not fetch on a hidden initial load or background network recovery", async () => {
    show(false);
    const refresh = vi.fn(async () => {});
    stop = startVisiblePolling(refresh);
    win.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(20000);
    expect(refresh).not.toHaveBeenCalled();
    show(true);
    expect(refresh).toHaveBeenCalledOnce();
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledTimes(2);
    show(false);
    await vi.advanceTimersByTimeAsync(20000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("aborts in-flight work and immediately resumes without an old request interfering", async () => {
    const requests: { signal: AbortSignal; finish: () => void }[] = [];
    stop = startVisiblePolling((signal) => new Promise<void>((finish) => requests.push({ signal, finish })));
    expect(requests).toHaveLength(1);
    show(false);
    expect(requests[0].signal.aborted).toBe(true);
    show(true);
    expect(requests).toHaveLength(2);
    requests[0].finish();
    await settle();
    await vi.advanceTimersByTimeAsync(10000);
    expect(requests).toHaveLength(2);
    requests[1].finish();
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(requests).toHaveLength(3);
    stop();
    expect(requests[2].signal.aborted).toBe(true);
    requests[2].finish();
    show(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(requests).toHaveLength(3);
  });
});
