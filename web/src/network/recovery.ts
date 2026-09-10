// 重试会创建新通道，不保留或重放任何协议消息。
export class ConnectionRecovery {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  enabled = false;
  constructor(private readonly retry: () => void) {}
  enable() { this.enabled = true; this.clear(); }
  connected() {
    this.clear();
    this.clearStable();
    // 短暂连通不能抹掉失败历史，避免弱网下反复以一秒间隔重建通道。
    if (this.enabled) this.stableTimer = setTimeout(() => {
      this.stableTimer = undefined;
      this.failures = 0;
    }, 30_000);
  }
  failed() {
    this.clearStable();
    if (!this.enabled || this.timer !== undefined) return;
    const delay = Math.min(1000 * 2 ** Math.min(this.failures++, 5), 30_000);
    this.timer = setTimeout(() => { this.timer = undefined; if (this.enabled) this.retry(); }, delay);
  }
  online() {
    if (!this.enabled) return;
    this.clear(); this.failures = 0; this.failed();
  }
  stop() { this.enabled = false; this.clear(); this.clearStable(); this.failures = 0; }
  private clear() { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; }
  private clearStable() { if (this.stableTimer !== undefined) clearTimeout(this.stableTimer); this.stableTimer = undefined; }
}
