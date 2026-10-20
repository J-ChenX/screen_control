// 仅在本地比较低分辨率画面，不保留原始截图，也不上传像素。
export class DesktopMotion {
  private canvas: HTMLCanvasElement | null = null;
  private previous: Uint8ClampedArray | null = null;
  private lastSample = -Infinity;
  private lastComparison = -Infinity;
  private width = 0;
  private height = 0;
  private disabled = false;

  sample(source: HTMLCanvasElement, now: number): number | undefined {
    if (this.disabled || now - this.lastSample < 200 || !source.ownerDocument) return;
    this.lastSample = now;
    try {
      if (!this.canvas) {
        this.canvas = source.ownerDocument.createElement('canvas');
        this.canvas.width = 32; this.canvas.height = 18;
      }
      const context = this.canvas.getContext('2d', { willReadFrequently: true });
      if (!context) { this.dispose(); this.disabled = true; return; }
      context.drawImage(source, 0, 0, 32, 18);
      const pixels = context.getImageData(0, 0, 32, 18).data;
      const previous = this.previous;
      const sameSize = this.width === source.width && this.height === source.height;
      this.previous = pixels; this.width = source.width; this.height = source.height;
      if (!previous || !sameSize || now - this.lastComparison >= 1000) { this.lastComparison = now; return; }
      this.lastComparison = now;
      let changed = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        // 忽略轻微 JPEG 噪声，小范围指针／光标变化不会视为大面积运动。
        const difference = Math.abs(pixels[offset] - previous[offset]) + Math.abs(pixels[offset + 1] - previous[offset + 1]) + Math.abs(pixels[offset + 2] - previous[offset + 2]);
        if (difference >= 48) changed++;
      }
      return changed / (32 * 18);
    } catch {
      // 采样不可用时回退到延迟策略，不能中断远程画面或反馈。
      this.dispose(); this.disabled = true;
    }
  }
  dispose() {
    if (this.canvas) this.canvas.width = this.canvas.height = 1;
    this.canvas = null; this.previous = null;
  }
}
