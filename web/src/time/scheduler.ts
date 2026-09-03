export interface Scheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type Pending = { at: number; callback: () => void; cancelled: boolean };

export class ManualScheduler implements Scheduler {
  private pending: Pending[] = [];

  constructor(private currentMs: number) {}

  now(): number {
    return this.currentMs;
  }

  setTimeout(callback: () => void, delayMs: number): Pending {
    const item = { at: this.currentMs + Math.max(0, delayMs), callback, cancelled: false };
    this.pending.push(item);
    return item;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "object" && handle !== null && "cancelled" in handle) {
      (handle as Pending).cancelled = true;
    }
  }

  advance(deltaMs: number): void {
    if (deltaMs < 0) throw new Error("manual monotonic scheduler cannot move backwards");
    this.currentMs += deltaMs;
    const due = this.pending.filter((item) => !item.cancelled && item.at <= this.currentMs);
    this.pending = this.pending.filter((item) => item.cancelled || item.at > this.currentMs);
    due.sort((left, right) => left.at - right.at).forEach((item) => item.callback());
  }
}

