import { describe, expect, it, vi } from "vitest";
import { ManualScheduler } from "./scheduler";

describe("ManualScheduler", () => {
  it("fires only at the exact boundary", () => {
    const scheduler = new ManualScheduler(0);
    const callback = vi.fn();
    scheduler.setTimeout(callback, 7 * 24 * 60 * 60 * 1000);
    scheduler.advance(7 * 24 * 60 * 60 * 1000 - 1);
    expect(callback).not.toHaveBeenCalled();
    scheduler.advance(1);
    expect(callback).toHaveBeenCalledOnce();
  });

  it("rejects monotonic rollback", () => {
    expect(() => new ManualScheduler(0).advance(-1)).toThrow(/cannot move backwards/);
  });
});

