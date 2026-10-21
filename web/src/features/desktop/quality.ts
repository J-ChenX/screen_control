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
  private sampleLifetime = 1000;
  private load: DesktopLoad = { queueMs: 0, decodeMs: 0, processingMs: 0, ackMs: 0 };
  private pressure = 0;
  private networkPressure = 0;
  private networkSamples = 0;
  private cadenceSamples = 0;
  private qualityStep = 0;
  private cadenceStep = 0;
  private refined = false;
  private tuningDirty = false;
  private tuningSince: number | null = null;
  private tuningHealthySince: number | null = null;
  private lastQualityChange = -Infinity;
  private lastCadenceChange = -Infinity;
  private processing = 0;
  private congestedSamples = 0;
  private severeSamples = 0;
  private activity: DesktopActivity = 'unknown';
  private activityCandidate: DesktopActivity = 'unknown';
  private activitySince = 0;
  private lastMotionSample = -Infinity;
  private activePolicy: DesktopActivity = 'unknown';
  constructor(private readonly change: (tier: DesktopTier) => void, private smooth = false, private resolution: DesktopResolution = 'auto', private readonly retune?: () => void) {
    this.tier = resolution === 'auto' ? 1440 : resolution;
  }
  private resetLoad() {
    this.congestedSince = this.healthySince = this.severeSince = null;
    this.lastSample = -Infinity;
    this.sampleLifetime = 1000;
    this.pressure = this.processing = this.congestedSamples = this.severeSamples = 0;
    this.networkPressure = this.networkSamples = this.cadenceSamples = 0;
    this.tuningSince = this.tuningHealthySince = null;
    this.activity = this.activityCandidate = this.activePolicy = 'unknown';
    this.lastMotionSample = -Infinity;
  }
  priority(smooth: boolean) { this.smooth = smooth; this.resetTuning(); this.resetLoad(); this.change(this.tier); }
  setResolution(resolution: DesktopResolution) {
    this.resolution = resolution;
    this.resetTuning();
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
    const interval = now - this.lastSample;
    // 慢链路的一帧可能传输数秒；保留连续反馈，但不串联长时间断开的旧样本。
    const recent = interval < 15000;
    this.sampleLifetime = Math.min(15000, Math.max(1000, load.ackMs * 2, recent ? interval * 2 : 0));
    this.pressure = recent ? this.pressure * .8 + sample * .2 : sample;
    this.networkPressure = recent ? this.networkPressure * .8 + load.ackMs * .2 : load.ackMs;
    this.networkSamples = load.ackMs >= 160 ? (recent ? this.networkSamples : 0) + 1 : 0;
    this.cadenceSamples = sample >= 160 || load.processingMs > 40 ? (recent ? this.cadenceSamples : 0) + 1 : 0;
    if (this.refined && ((load.motionRatio ?? 0) >= .12 || this.networkSamples >= 3)) {
      this.refined = false; this.tuningDirty = true;
    }
    this.processing = recent ? this.processing * .8 + load.processingMs * .2 : load.processingMs;
    this.congestedSamples = sample >= threshold || (this.smooth && load.processingMs > 60) || (moving && load.processingMs >= threshold) ? (recent ? this.congestedSamples : 0) + 1 : 0;
    this.severeSamples = sample >= 500 ? (recent ? this.severeSamples : 0) + 1 : 0;
    this.load = load; this.lastSample = now;
  }
  private resetTuning() {
    this.qualityStep = this.cadenceStep = 0;
    this.refined = this.tuningDirty = false;
    this.lastQualityChange = this.lastCadenceChange = -Infinity;
  }
  private tune(now: number, queueMs: number, recent: boolean, allowRefine: boolean) {
    const before = `${this.quality(false)}:${this.quality(true)}:${this.interval()}`;
    const pressure = Math.max(queueMs, recent ? this.pressure : 0);
    const processing = recent ? this.processing : 0;
    const busy = pressure >= 160 || processing > 40;
    if (busy) { this.tuningSince ??= now; this.tuningHealthySince = null; }
    else { this.tuningSince = null; this.tuningHealthySince ??= now; }
    // 传输反馈决定 JPEG 质量；采集、解码和传输共同决定更新频率。
    // 至少三个真实样本，且每次调整间隔两秒；单个迟到 ACK 不改变配置。
    if (this.tuningSince !== null && now - this.tuningSince >= 600) {
      if (recent && this.networkSamples >= 3 && this.networkPressure >= 160 && now - this.lastQualityChange >= 2000) {
        this.qualityStep = Math.min(3, this.qualityStep + 1); this.lastQualityChange = now;
      }
      if ((queueMs >= 160 || (recent && this.cadenceSamples >= 3)) && this.interval() < Math.max(processing * 1.1, pressure / 2) && now - this.lastCadenceChange >= 2000) {
        this.cadenceStep = Math.min(3, this.cadenceStep + 1); this.lastCadenceChange = now;
      }
    }
    const healthy = recent && pressure < 80 && processing < 32;
    if (!healthy) this.tuningHealthySince = null;
    if (healthy && this.tuningHealthySince !== null && now - this.tuningHealthySince >= 4000) {
      if (now - this.lastQualityChange >= 4000) { this.qualityStep = Math.max(0, this.qualityStep - 1); this.lastQualityChange = now; }
      if (now - this.lastCadenceChange >= 4000) { this.cadenceStep = Math.max(0, this.cadenceStep - 1); this.lastCadenceChange = now; }
    }
    // 静止时没有新帧；等超过慢链路的反馈观察期，空队列只补一次高清基准。
    if (allowRefine && Number.isFinite(this.lastSample) && queueMs === 0 && now - this.lastSample >= Math.max(1500, this.sampleLifetime * 2)) {
      if (!this.refined) {
        // 补帧回执是一条新观察，不能复用静止前的连续拥塞计数形成刷新循环。
        this.networkSamples = this.cadenceSamples = 0;
      }
      this.refined = true; this.qualityStep = 0;
    }
    if (this.tuningDirty || before !== `${this.quality(false)}:${this.quality(true)}:${this.interval()}`) this.retune?.();
    this.tuningDirty = false;
  }
  tick(now: number, queueMs: number, allowRefine = true) {
    const recent = now - this.lastSample < this.sampleLifetime;
    this.tune(now, queueMs, recent, allowRefine);
    if (this.resolution !== 'auto') return;
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
  interval() { return [40, 60, 80, 120][this.cadenceStep]; }
  quality(smooth: boolean) {
    if (this.refined) return 90;
    const base = this.tier === 1440 ? 90 : this.tier === 1080 ? 85 : this.tier === 720 ? 80 : 75;
    return Math.max(60, base - (smooth ? 5 : 0) - this.qualityStep * 5);
  }
}
