import { expect, it, vi } from 'vitest';
import { DesktopMotion } from './motion';

function setup() {
  let pixels: Uint8ClampedArray = new Uint8ClampedArray(32 * 18 * 4);
  const drawImage = vi.fn(), getImageData = vi.fn(() => ({ data: pixels.slice() }));
  const scratch = { width: 0, height: 0, getContext: vi.fn(() => ({ drawImage, getImageData })) };
  const source = { width: 2560, height: 1440, ownerDocument: { createElement: vi.fn(() => scratch) } } as unknown as HTMLCanvasElement;
  return { source, scratch, drawImage, getImageData, setPixels(next: Uint8ClampedArray) { pixels = next; } };
}

it('忽略轻微噪声，小范围变化与整面变化得到不同活动量', () => {
  const state = setup(), motion = new DesktopMotion();
  expect(motion.sample(state.source, 0)).toBeUndefined();
  state.setPixels(new Uint8ClampedArray(32 * 18 * 4).fill(8));
  expect(motion.sample(state.source, 200)).toBe(0);
  const pixels = new Uint8ClampedArray(32 * 18 * 4).fill(8);
  pixels.fill(255, 0, 4 * 8); state.setPixels(pixels);
  expect(motion.sample(state.source, 400)).toBeCloseTo(8 / (32 * 18));
  state.setPixels(new Uint8ClampedArray(32 * 18 * 4).fill(255));
  expect(motion.sample(state.source, 600)).toBeCloseTo(1 - 8 / (32 * 18));
  motion.dispose(); expect(state.scratch.width * state.scratch.height).toBe(1);
});

it('限制采样频率，切换尺寸与长时间静止后的首帧只建立比较基线', () => {
  const state = setup(), motion = new DesktopMotion();
  motion.sample(state.source, 0);
  for (let now = 1; now < 200; now++) motion.sample(state.source, now);
  expect(state.drawImage).toHaveBeenCalledTimes(1);
  state.setPixels(new Uint8ClampedArray(32 * 18 * 4).fill(255));
  state.source.width = 1920; state.source.height = 1080;
  expect(motion.sample(state.source, 200)).toBeUndefined();
  expect(motion.sample(state.source, 400)).toBe(0);
  state.setPixels(new Uint8ClampedArray(32 * 18 * 4));
  expect(motion.sample(state.source, 2000)).toBeUndefined();
  expect(motion.sample(state.source, 2200)).toBe(0);
});

it('采样失败只停用活动检测，不向显示管线抛出异常', () => {
  const state = setup(), motion = new DesktopMotion();
  state.getImageData.mockImplementation(() => { throw new Error('读取失败'); });
  expect(motion.sample(state.source, 0)).toBeUndefined();
  expect(motion.sample(state.source, 200)).toBeUndefined();
  expect(state.getImageData).toHaveBeenCalledTimes(1);
  expect(state.scratch.width * state.scratch.height).toBe(1);
});
