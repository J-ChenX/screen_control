// 重试会创建新通道，不保留或重放任何协议消息。
export class ConnectionRecovery {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  enabled = false;
  constructor(private readonly retry: () => void) {}
  enable() { this.enabled = true; }
  connected() { this.clear(); this.failures = 0; }
  failed() {
    if (!this.enabled || this.timer !== undefined) return;
    const delay = Math.min(1000 * 2 ** Math.min(this.failures++, 5), 30_000);
    this.timer = setTimeout(() => { this.timer = undefined; if (this.enabled) this.retry(); }, delay);
  }
  online() {
    if (!this.enabled) return;
    this.clear(); this.failures = 0; this.failed();
  }
  stop() { this.enabled = false; this.clear(); this.failures = 0; }
  private clear() { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; }
}
