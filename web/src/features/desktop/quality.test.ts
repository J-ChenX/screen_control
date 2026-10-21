import { expect, it, vi } from 'vitest';
import { applyDesktopQuality, desktopQuality, DesktopAdaptation, type DesktopLoad } from './quality';
import type { MeshDesktopModule } from '../meshcentral';

it('普通模式与流畅优先均保持帧率，档位由自适应策略统一决定', () => {
  expect(desktopQuality('Ubuntu', false)).toEqual({ type: 1, quality: 90, scaling: 1024, interval: 40 });
  expect(desktopQuality('Ubuntu', true)).toEqual({ type: 1, quality: 85, scaling: 1024, interval: 40 });
  expect(desktopQuality('Windows', true)).toEqual({ type: 1, quality: 85, scaling: 1024, interval: 40 });
});
it('先切换画质，再请求整屏刷新，使静止区域重新编码', () => {
  const compression = vi.fn(), refresh = vi.fn();
  const module = { SendCompressionLevel: compression, SendRefresh: refresh } as unknown as MeshDesktopModule;
  applyDesktopQuality(module, 'Ubuntu', false);
  expect(compression).toHaveBeenCalledWith(1, 90, 1024, 40); expect(refresh).toHaveBeenCalledOnce();
  expect(compression.mock.invocationCallOrder[0]).toBeLessThan(refresh.mock.invocationCallOrder[0]);
});

const load = (ackMs = 20, processingMs = 25) => ({ queueMs: 10, decodeMs: 5, processingMs, ackMs });
function sampleRange(adaptation: DesktopAdaptation, start: number, end: number, value: DesktopLoad = load(), waiting = 0) {
  for (let now = start; now <= end; now += 200) { adaptation.observe(value, now); adaptation.tick(now, waiting); }
}

it('持续展示滞后才逐级降档，真实队列严重过期仍快速保护并逐级恢复', () => {
  const changed: number[] = [], adaptation = new DesktopAdaptation(tier => changed.push(tier));
  sampleRange(adaptation, 0, 2800, load(260)); expect(adaptation.tier).toBe(1440);
  sampleRange(adaptation, 3000, 3000, load(260)); expect(adaptation.tier).toBe(1080);
  adaptation.tick(4000, 600); expect(adaptation.tier).toBe(540);
  sampleRange(adaptation, 4200, 12200); expect(adaptation.tier).toBe(720);
  sampleRange(adaptation, 12400, 20400); expect(adaptation.tier).toBe(1080);
  sampleRange(adaptation, 20600, 28600); expect(adaptation.tier).toBe(1440);
  expect(changed).toEqual([1080, 540, 720, 1080, 1440]);
});

it('清晰优先容忍持续中等延迟，流畅优先仍及时降档', () => {
  const normal = new DesktopAdaptation(vi.fn()), smooth = new DesktopAdaptation(vi.fn(), true);
  sampleRange(normal, 0, 60000, load(220));
  sampleRange(smooth, 0, 1000, load(220));
  expect(normal.tier).toBe(1440); expect(smooth.tier).toBe(1080);
});

it('反复出现的两秒多展示波动不降档，持续超限仍逐级保护', () => {
  const change = vi.fn(), adaptation = new DesktopAdaptation(change);
  for (let now = 0; now <= 60000; now += 200) {
    adaptation.observe(load(now % 6000 < 2600 ? 320 : 30), now);
    adaptation.tick(now, 10);
  }
  expect(adaptation.tier).toBe(1440); expect(change).not.toHaveBeenCalled();
  sampleRange(adaptation, 60200, 65000, load(320));
  expect(adaptation.tier).toBe(1080);
  sampleRange(adaptation, 65200, 70200, load(320));
  expect(adaptation.tier).toBe(720);
});

it('没有新帧反馈时，本地队列采用同样的清晰优先观察窗口', () => {
  const adaptation = new DesktopAdaptation(vi.fn());
  for (let now = 0; now <= 10000; now += 200) adaptation.tick(now, 220);
  expect(adaptation.tier).toBe(1440);
  for (let now = 10200; now <= 13000; now += 200) adaptation.tick(now, 260);
  expect(adaptation.tier).toBe(1440);
  adaptation.tick(13200, 260); expect(adaptation.tier).toBe(1080);
});

it('同样的中等展示延迟下，小范围变化保留清晰，大面积持续运动更早降档', () => {
  const still = new DesktopAdaptation(vi.fn()), moving = new DesktopAdaptation(vi.fn());
  sampleRange(still, 0, 20000, { ...load(280), motionRatio: .01 });
  sampleRange(moving, 0, 1800, { ...load(280), motionRatio: .5 });
  expect(still.tier).toBe(1440); expect(moving.tier).toBe(1440);
  sampleRange(moving, 2000, 2000, { ...load(280), motionRatio: .5 });
  expect(moving.tier).toBe(1080);
});

it('大面积运动本身不降档，健康静态画面仍按原观察期逐级恢复', () => {
  const adaptation = new DesktopAdaptation(vi.fn());
  sampleRange(adaptation, 0, 10000, { ...load(), motionRatio: .8 });
  expect(adaptation.tier).toBe(1440);
  sampleRange(adaptation, 10200, 12200, { ...load(280), motionRatio: .8 });
  expect(adaptation.tier).toBe(1440);
  sampleRange(adaptation, 12400, 14000, { ...load(280), motionRatio: .8 });
  expect(adaptation.tier).toBe(1080);
  sampleRange(adaptation, 14200, 25200, { ...load(), motionRatio: 0 });
  expect(adaptation.tier).toBe(1440);
});

it('单次大幅画面切换不会按持续运动降档，过期运动信号回退普通策略', () => {
  const adaptation = new DesktopAdaptation(vi.fn());
  sampleRange(adaptation, 0, 2000, { ...load(220), motionRatio: 0 });
  sampleRange(adaptation, 2200, 2200, { ...load(220), motionRatio: .8 });
  sampleRange(adaptation, 2400, 10000, { ...load(220), motionRatio: 0 });
  expect(adaptation.tier).toBe(1440);
  sampleRange(adaptation, 10200, 10600, { ...load(220), motionRatio: .8 });
  sampleRange(adaptation, 10800, 16000, load(220));
  expect(adaptation.tier).toBe(1440);
});

it('低动态仍保护持续严重反馈和真实积压，固定分辨率忽略运动', () => {
  const adaptation = new DesktopAdaptation(vi.fn()), fixed = new DesktopAdaptation(vi.fn(), false, 1440);
  sampleRange(adaptation, 0, 1200, { ...load(700), motionRatio: 0 });
  expect(adaptation.tier).toBe(540);
  sampleRange(fixed, 0, 10000, { ...load(700), motionRatio: 1 }, 700);
  expect(fixed.tier).toBe(1440);
});

it('高动态时持续处理耗时也会触发降档，静态编码稍慢仍保留清晰', () => {
  const still = new DesktopAdaptation(vi.fn()), moving = new DesktopAdaptation(vi.fn());
  sampleRange(still, 0, 10000, { ...load(20, 220), motionRatio: 0 });
  sampleRange(moving, 0, 2000, { ...load(20, 220), motionRatio: .5 });
  expect(still.tier).toBe(1440); expect(moving.tier).toBe(1080);
  sampleRange(moving, 2200, 18200, { ...load(20, 120), motionRatio: .5 });
  expect(moving.tier).toBe(1080);
  sampleRange(moving, 18400, 29000, { ...load(20, 120), motionRatio: 0 });
  expect(moving.tier).toBe(1440);
});

it('动态降档后，转为小范围变化时容忍中等延迟并恢复清晰度', () => {
  const adaptation = new DesktopAdaptation(vi.fn());
  sampleRange(adaptation, 0, 2000, { ...load(280), motionRatio: .5 });
  expect(adaptation.tier).toBe(1080);
  sampleRange(adaptation, 2200, 11000, { ...load(220), motionRatio: .01 });
  expect(adaptation.tier).toBe(1080);
  sampleRange(adaptation, 11200, 11200, { ...load(220), motionRatio: .01 });
  expect(adaptation.tier).toBe(1440);
});

it('好网络中的反复短时反馈尖峰和编码耗时波动保持清晰，不频繁切档', () => {
  const changed = vi.fn(), adaptation = new DesktopAdaptation(changed);
  for (let now = 0; now <= 60000; now += 200) {
    const peak = now % 6000 < 400;
    adaptation.observe(load(peak ? 350 : 30, peak ? 100 : 70), now);
    adaptation.tick(now, 10);
  }
  expect(adaptation.tier).toBe(1440); expect(changed).not.toHaveBeenCalled();
});

it('单次迟到反馈不会触发最低档，持续严重反馈仍在短时间内保护', () => {
  const adaptation = new DesktopAdaptation(vi.fn());
  adaptation.observe(load(700), 0);
  for (let now = 0; now <= 2000; now += 200) adaptation.tick(now, 0);
  expect(adaptation.tier).toBe(1440);
  sampleRange(adaptation, 3000, 4000, load(700));
  expect(adaptation.tier).toBe(540);
});

it.each([1250, 3750, 6000])('每 %i 毫秒才展示一帧时，持续数秒反馈仍能自动降档', interval => {
  const adaptation = new DesktopAdaptation(vi.fn());
  for (let now = 0; now <= interval * 3; now += 50) {
    if (now % interval === 0) adaptation.observe({ ...load(2500), motionRatio: .2 }, now);
    if (now % 200 === 0) adaptation.tick(now, 0);
  }
  expect(adaptation.tier).toBe(540);
  sampleRange(adaptation, interval * 3 + 200, interval * 3 + 30000);
  expect(adaptation.tier).toBe(1440);
});

it('间隔很长的孤立迟到帧不会被拼成持续拥塞，固定档位仍保持不变', () => {
  const automatic = new DesktopAdaptation(vi.fn()), fixed = new DesktopAdaptation(vi.fn(), false, 1440);
  for (let now = 0; now <= 60000; now += 200) {
    if (now % 20000 === 0) {
      automatic.observe(load(2500), now);
      fixed.observe(load(2500), now);
    }
    automatic.tick(now, 0); fixed.tick(now, 0);
  }
  expect(automatic.tier).toBe(1440); expect(fixed.tier).toBe(1440);
});

it('升档试探失败后延长恢复观察，避免在相邻分辨率间来回切换', () => {
  const changed: number[] = [], adaptation = new DesktopAdaptation(tier => changed.push(tier));
  sampleRange(adaptation, 0, 3000, load(260)); expect(adaptation.tier).toBe(1080);
  sampleRange(adaptation, 3200, 11200); expect(adaptation.tier).toBe(1440);
  sampleRange(adaptation, 11400, 16200, load(400)); expect(adaptation.tier).toBe(1080);
  sampleRange(adaptation, 16400, 32200); expect(adaptation.tier).toBe(1080);
  sampleRange(adaptation, 32400, 32400); expect(adaptation.tier).toBe(1440);
  expect(changed).toEqual([1080, 1440, 1080, 1440]);
});

it('流畅优先继续更早响应持续编码压力，默认模式优先保留清晰度', () => {
  const normal = new DesktopAdaptation(vi.fn()), smooth = new DesktopAdaptation(vi.fn(), true);
  sampleRange(normal, 0, 1000, load(30, 100));
  sampleRange(smooth, 0, 1000, load(30, 100));
  expect(normal.tier).toBe(1440); expect(smooth.tier).toBe(1080);
});
it('低负载快速更新保持 2K，静止时不反复发送切档请求', () => {
  const change = vi.fn(), adaptation = new DesktopAdaptation(change);
  for (let now = 0; now <= 10000; now += 200) {
    adaptation.observe({ queueMs: 8, decodeMs: 4, processingMs: 15, ackMs: 20 }, now); adaptation.tick(now,8);
  }
  expect(adaptation.tier).toBe(1440); expect(change).not.toHaveBeenCalled();
});
it('已有自适应入口时，手动按钮只改变策略优先级', () => {
  const module = {SetDesktopPriority:vi.fn(),SendCompressionLevel:vi.fn(),SendRefresh:vi.fn()} as unknown as MeshDesktopModule;
  applyDesktopQuality(module,'Ubuntu',true); expect(module.SetDesktopPriority).toHaveBeenCalledWith(true);
  expect(module.SendCompressionLevel).not.toHaveBeenCalled();
});

it('固定分辨率不随负载或流畅优先切档，恢复自动后重新自适应', () => {
  const change = vi.fn(), adaptation = new DesktopAdaptation(change);
  for (const tier of [1440, 1080, 720] as const) {
    adaptation.setResolution(tier);
    for (let now = 0; now <= 8000; now += 200) {
      adaptation.observe({ queueMs: 400, decodeMs: 300, processingMs: 200, ackMs: 500 }, now);
      adaptation.tick(now, 400);
    }
    expect(adaptation.tier).toBe(tier);
    adaptation.priority(true);
    expect(change).toHaveBeenLastCalledWith(tier);
  }
  adaptation.setResolution('auto');
  expect(adaptation.tier).toBe(1440);
  sampleRange(adaptation, 9000, 12000, load(260));
  expect(adaptation.tier).toBe(1080);
});

it('重连以保留的固定档位启动', () => {
  const adaptation = new DesktopAdaptation(vi.fn(), false, 720);
  expect(adaptation.tier).toBe(720);
  adaptation.tick(0, 300);
  expect(adaptation.tier).toBe(720);
});

it('先适度降低 JPEG 质量及采集频率，持续过载后才降低分辨率', () => {
  const retune = vi.fn(), change = vi.fn();
  const adaptation = new DesktopAdaptation(change, false, 'auto', retune);
  sampleRange(adaptation, 0, 600, load(260));
  expect(adaptation.tier).toBe(1440); expect(adaptation.quality(false)).toBe(85); expect(adaptation.interval()).toBe(60);
  expect(change).not.toHaveBeenCalled(); expect(retune).toHaveBeenCalledOnce();
  sampleRange(adaptation, 800, 3000, load(260));
  expect(adaptation.tier).toBe(1080); expect(adaptation.quality(false)).toBe(75); expect(adaptation.interval()).toBe(80);
});

it('纯处理压力只调整采集间隔，不无故降低 JPEG 质量或分辨率', () => {
  const adaptation = new DesktopAdaptation(vi.fn());
  sampleRange(adaptation, 0, 20000, load(20, 50));
  expect(adaptation.tier).toBe(1440); expect(adaptation.quality(false)).toBe(90); expect(adaptation.interval()).toBe(60);
});

it('固定分辨率仍独立调整压缩和频率，并严格限制质量与采集周期', () => {
  const adaptation = new DesktopAdaptation(vi.fn(), true, 720);
  sampleRange(adaptation, 0, 60000, load(1000, 200));
  expect(adaptation.tier).toBe(720); expect(adaptation.quality(true)).toBe(60); expect(adaptation.interval()).toBe(120);
  sampleRange(adaptation, 60200, 90000);
  expect(adaptation.tier).toBe(720); expect(adaptation.quality(true)).toBe(75); expect(adaptation.interval()).toBe(40);
});

it('单次迟到反馈和反复短尖峰不改变压缩及采集频率', () => {
  const retune = vi.fn(), adaptation = new DesktopAdaptation(vi.fn(), false, 'auto', retune);
  for (let now = 0; now <= 60000; now += 200) {
    adaptation.observe(load(now % 6000 < 400 ? 700 : 20), now); adaptation.tick(now, 0);
  }
  expect(adaptation.quality(false)).toBe(90); expect(adaptation.interval()).toBe(40); expect(retune).not.toHaveBeenCalled();
});

it('静止窗口补一次 Q90，慢反馈未过期或仍有待绘制图片时不补帧', () => {
  const retune = vi.fn(), adaptation = new DesktopAdaptation(vi.fn(), true, 1080, retune);
  adaptation.observe(load(2500), 0);
  adaptation.tick(4000, 0); expect(retune).not.toHaveBeenCalled();
  adaptation.tick(10000, 0, false); expect(retune).not.toHaveBeenCalled();
  adaptation.tick(10200, 0); expect(adaptation.quality(true)).toBe(90); expect(retune).toHaveBeenCalledOnce();
  for (let now = 10400; now <= 60000; now += 200) adaptation.tick(now, 0);
  expect(retune).toHaveBeenCalledOnce();
  adaptation.observe({ ...load(), motionRatio: .5 }, 60200); adaptation.tick(60200, 0);
  expect(adaptation.quality(true)).toBe(80); expect(retune).toHaveBeenCalledTimes(2);
});

it('健康样本持续四秒才逐级恢复采集及压缩，切换手动配置立即重置', () => {
  const adaptation = new DesktopAdaptation(vi.fn(), false, 1440);
  sampleRange(adaptation, 0, 5000, load(260));
  expect(adaptation.quality(false)).toBe(75); expect(adaptation.interval()).toBe(120);
  sampleRange(adaptation, 5200, 8000);
  expect(adaptation.quality(false)).toBe(75);
  sampleRange(adaptation, 8200, 16000);
  expect(adaptation.quality(false)).toBeGreaterThan(75); expect(adaptation.interval()).toBeLessThan(120);
  adaptation.priority(true); expect(adaptation.quality(true)).toBe(85); expect(adaptation.interval()).toBe(40);
});

it.each([undefined, 0])('静止补帧回执重新进入策略后不循环请求完整帧，活动量为 %s', motionRatio => {
  let now = 0;
  const replies: number[] = [], settings: number[] = [];
  const adaptation = new DesktopAdaptation(vi.fn(), false, 1080, () => {
    settings.push(adaptation.quality(false)); replies.push(now + 400);
  });
  for (; now <= 60000; now += 200) {
    if (now <= 400 || replies.includes(now)) adaptation.observe({ ...load(260), motionRatio }, now);
    adaptation.tick(now, 0);
  }
  expect(settings.filter(quality => quality === 90)).toHaveLength(1);
  expect(settings.at(-1)).toBe(90); expect(adaptation.quality(false)).toBe(90);
  expect(settings.length).toBeLessThanOrEqual(5);
});
