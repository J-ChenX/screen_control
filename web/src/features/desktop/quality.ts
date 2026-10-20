import type { MeshDesktopModule } from '../meshcentral';
import type { DesktopTier } from './frame';

export type DesktopResolution = 'auto' | 1440 | 1080 | 720;

export function desktopQuality(_platform: string, smooth: boolean) {
  return { type: 1, quality: smooth ? 85 : 90, scaling: 1024, interval: 40 };
}
export function applyDesktopQuality(module: MeshDesktopModule, platform: string, smooth: boolean) {
  if (module.SetDesktopPriority) { module.SetDesktopPriority(smooth); return; }
  const settings = desktopQuality(platform, smooth);
  module.SendCompressionLevel(settings.type, settings.quality, settings.scaling, settings.interval);
  module.SendRefresh?.();
}

export type DesktopLoad = { queueMs: number; decodeMs: number; processingMs: number; ackMs: number; motionRatio?: number };
type DesktopActivity = 'unknown' | 'still' | 'moving';
export class DesktopAdaptation {
  tier: DesktopTier = 1440;
  private congestedSince: number | null = null;
  private healthySince: number | null = null;
  private severeSince: number | null = null;
  private lastChange = -Infinity;
  private lastUpgrade = -Infinity;
  private recoveryDelay = 8000;
  private lastSample = -Infinity;
  private load: DesktopLoad = { queueMs: 0, decodeMs: 0, processingMs: 0, ackMs: 0 };
  private pressure = 0;
  private processing = 0;
  private congestedSamples = 0;
  private severeSamples = 0;
  private activity: DesktopActivity = 'unknown';
  private activityCandidate: DesktopActivity = 'unknown';
  private activitySince = 0;
  private lastMotionSample = -Infinity;
  private activePolicy: DesktopActivity = 'unknown';
  constructor(private readonly change: (tier: DesktopTier) => void, private smooth = false, private resolution: DesktopResolution = 'auto') {
    this.tier = resolution === 'auto' ? 1440 : resolution;
  }
  private resetLoad() {
    this.congestedSince = this.healthySince = this.severeSince = null;
    this.lastSample = -Infinity;
    this.pressure = this.processing = this.congestedSamples = this.severeSamples = 0;
    this.activity = this.activityCandidate = this.activePolicy = 'unknown';
    this.lastMotionSample = -Infinity;
  }
  priority(smooth: boolean) { this.smooth = smooth; this.resetLoad(); this.change(this.tier); }
  setResolution(resolution: DesktopResolution) {
    this.resolution = resolution;
    this.tier = resolution === 'auto' ? 1440 : resolution;
    this.resetLoad();
    this.lastChange = this.lastUpgrade = -Infinity;
    this.recoveryDelay = 8000;
    this.change(this.tier);
  }
  private policy(now: number) {
    const activity = !this.smooth && now - this.lastMotionSample < 1000 ? this.activity : 'unknown';
    if (activity !== this.activePolicy) {
      this.activePolicy = activity;
      this.congestedSince = this.healthySince = null;
      this.congestedSamples = 0;
    }
    if (this.smooth) return { threshold: 100, duration: 1000, cooldown: 3000, moving: false };
    if (activity === 'still') return { threshold: 320, duration: 4000, cooldown: 5000, moving: false };
    if (activity === 'moving') return { threshold: 160, duration: 1600, cooldown: 3000, moving: true };
    return { threshold: 240, duration: 3000, cooldown: 5000, moving: false };
  }
  observe(load: DesktopLoad, now: number) {
    if (load.motionRatio !== undefined && Number.isFinite(load.motionRatio) && load.motionRatio >= 0 && load.motionRatio <= 1) {
      if (now - this.lastMotionSample >= 1000) this.activity = this.activityCandidate = 'unknown';
      this.lastMotionSample = now;
      const candidate = load.motionRatio >= .12 ? 'moving' : load.motionRatio <= .04 ? 'still' : this.activity;
      if (candidate !== this.activityCandidate) { this.activityCandidate = candidate; this.activitySince = now; }
      if (now - this.activitySince >= (candidate === 'moving' ? 400 : 1000)) this.activity = candidate;
    }
    const { threshold, moving } = this.policy(now);
    const sample = Math.max(load.queueMs, load.decodeMs, load.ackMs);
    const recent = now - this.lastSample < 1000;
    this.pressure = recent ? this.pressure * .8 + sample * .2 : sample;
    this.processing = recent ? this.processing * .8 + load.processingMs * .2 : load.processingMs;
    this.congestedSamples = sample >= threshold || (this.smooth && load.processingMs > 60) || (moving && load.processingMs >= threshold) ? (recent ? this.congestedSamples : 0) + 1 : 0;
    this.severeSamples = sample >= 500 ? (recent ? this.severeSamples : 0) + 1 : 0;
    this.load = load; this.lastSample = now;
  }
  tick(now: number, queueMs: number) {
    if (this.resolution !== 'auto') return;
    const recent = now - this.lastSample < 1000;
    const pressure = Math.max(queueMs, recent ? this.pressure : 0);
    const processing = recent ? this.processing : 0;
    const { threshold, duration, cooldown, moving } = this.policy(now);
    // 静态优先清晰，持续大面积运动优先延迟；活动本身不能单独触发降档。
    const congested = pressure >= threshold || (this.smooth && processing > 60) || (moving && processing >= threshold);
    const healthyPressure = this.smooth ? 40 : this.activePolicy === 'still' ? 240 : 80;
    const healthy = pressure < healthyPressure && (!this.smooth || processing < 32) && (!moving || processing < 80);
    const severe = recent && this.pressure >= 500 && Math.max(this.load.queueMs, this.load.decodeMs, this.load.ackMs) >= 500;
    if (severe) this.severeSince ??= now; else this.severeSince = null;
    if (congested) { this.congestedSince ??= now; this.healthySince = null; }
    else { this.congestedSince = null; if (healthy) this.healthySince ??= now; else this.healthySince = null; }
    let next = this.tier;
    // 实际待绘制队列严重过期仍快速保护，单个迟到反馈不能直降最低档。
    if (now - this.lastChange >= 1000 && (queueMs >= 500 || (this.severeSamples >= 3 && this.severeSince !== null && now - this.severeSince >= 1000))) next = 540;
    else if (now - this.lastChange >= cooldown && this.congestedSince !== null && now - this.congestedSince >= duration && (queueMs >= threshold || this.congestedSamples >= 3)) next = this.tier === 1440 ? 1080 : this.tier === 1080 ? 720 : 540;
    else if (now - this.lastChange >= this.recoveryDelay && this.healthySince !== null && now - this.healthySince >= this.recoveryDelay) next = this.tier === 540 ? 720 : this.tier === 720 ? 1080 : 1440;
    if (next === this.tier) return;
    if (next > this.tier) this.lastUpgrade = now;
    else {
      // 升档后短期再次过载，延后下一次试探，避免每几秒清晰／模糊来回切换。
      this.recoveryDelay = now - this.lastUpgrade <= 15000 ? Math.min(60000, this.recoveryDelay * 2) : 8000;
      this.lastUpgrade = -Infinity;
    }
    this.tier = next; this.lastChange = now; this.resetLoad(); this.change(next);
  }
  quality(smooth: boolean) { return this.tier === 1440 ? (smooth ? 85 : 90) : this.tier === 1080 ? (smooth ? 80 : 85) : this.tier === 720 ? (smooth ? 75 : 80) : (smooth ? 70 : 75); }
}
