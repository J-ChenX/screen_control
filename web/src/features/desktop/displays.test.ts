import { afterEach, expect, it, vi } from 'vitest';
import type { MeshDesktopModule } from '../meshcentral';
import { manageDesktopDisplays, type DesktopDisplays } from './displays';

afterEach(() => vi.useRealTimers());
const list = { '65535': 'All Displays', '1': 'Display 1', '2': 'Display 2' };
function setup(preferred: number | null = null) {
  vi.useFakeTimers();
  const mouse = vi.fn(), key = vi.fn(), text = vi.fn(), picture = vi.fn(), updates: DesktopDisplays[] = [];
  const module = { GetDisplayNumbers: vi.fn(), SetDisplay: vi.fn(), ResetDesktopDisplay: vi.fn(), SendRefresh: vi.fn(), ProcessBinaryCommand: vi.fn(), SendMouseMsg: mouse, SendKeyMsgKC: key, SendStringUnicode: text, ProcessPictureMsg: picture } as unknown as MeshDesktopModule;
  const controls = manageDesktopDisplays(module, preferred, state => updates.push(state));
  const report = (selected: number, displays: Record<string, string> = list) => module.onDisplayinfo!(module, displays, selected);
  const input = () => { module.SendMouseMsg(0, { pageX: 1, pageY: 1 }); module.SendKeyMsgKC(1, 65); module.SendStringUnicode('测试'); module.ProcessPictureMsg!(new Uint8Array(4), 0, 0); };
  return { module, controls, updates, report, input, mouse, key, text, picture };
}
it('默认选择第一个实际屏幕，代理确认前不展示合并画面或发送输入', () => {
  const s = setup(); s.controls.start(); s.input();
  expect(s.module.GetDisplayNumbers).toHaveBeenCalledOnce();
  s.report(65535);
  expect(s.module.SetDisplay).toHaveBeenCalledWith(1);
  expect(s.updates.at(-1)).toEqual({ ids: [1, 2], selected: null, pending: 1, error: null });
  s.report(65535); s.input();
  for (const method of [s.mouse, s.key, s.text, s.picture]) expect(method).not.toHaveBeenCalled();
  s.report(1); s.input();
  for (const method of [s.mouse, s.key, s.text, s.picture]) expect(method).toHaveBeenCalledOnce();
  expect(s.module.SendRefresh).toHaveBeenCalledOnce(); s.controls.dispose();
});
it('切换同尺寸屏幕也清理旧帧，不接受合并桌面或未知编号', () => {
  const s = setup(); s.report(1); s.controls.select(65535); s.controls.select(9);
  expect(s.module.SetDisplay).not.toHaveBeenCalled();
  s.controls.select(2); s.input(); s.report(1);
  expect(s.updates.at(-1)?.pending).toBe(2); expect(s.mouse).not.toHaveBeenCalled();
  s.report(2); expect(s.module.ResetDesktopDisplay).toHaveBeenCalledWith(true, undefined);
  expect(s.updates.at(-1)?.selected).toBe(2); s.controls.dispose();
});
it('物理尺寸按枚举顺序映射选屏，忽略设备名称编号和负坐标', () => {
  const s = setup();
  s.module.ProcessBinaryCommand!(82, 24, new Uint8Array([0, 82, 0, 24, 0, 4, 255, 255, 0, 0, 15, 0, 8, 112, 0, 1, 0, 0, 0, 0, 7, 128, 4, 56]));
  s.report(65535); expect(s.module.ResetDesktopDisplay).toHaveBeenLastCalledWith(true, { width: 3840, height: 2160 });
  s.report(1); s.controls.select(2); expect(s.module.ResetDesktopDisplay).toHaveBeenLastCalledWith(true, { width: 1920, height: 1080 });
  s.controls.dispose();
});
it('重连恢复本会话选择，屏幕移除后回退到可用单屏', () => {
  const s = setup(2); s.report(65535); expect(s.module.SetDisplay).toHaveBeenCalledWith(2);
  s.report(2); s.report(65535, { '1': 'Display 1' });
  expect(s.module.SetDisplay).toHaveBeenLastCalledWith(1); s.controls.dispose();
});
it('单屏空列表可以显示，提前收到列表后连接启动不会误报超时', () => {
  const s = setup(2); s.report(0, {}); s.controls.start(); vi.advanceTimersByTime(9000);
  expect(s.updates.at(-1)).toEqual({ ids: [0], selected: 0, pending: null, error: null });
  expect(s.module.SetDisplay).not.toHaveBeenCalled(); s.controls.dispose();
});
it('超时保持输入禁止并允许显式重试，销毁后忽略旧回调', () => {
  const s = setup(); s.report(65535); vi.advanceTimersByTime(8000); s.input();
  expect(s.updates.at(-1)?.error).toContain('未获确认'); expect(s.mouse).not.toHaveBeenCalled();
  s.controls.retry(); s.report(1); expect(s.updates.at(-1)?.error).toBeNull();
  const late = s.module.onDisplayinfo!; s.controls.dispose(); const count = s.updates.length;
  late(s.module, list, 2); vi.advanceTimersByTime(9000); expect(s.updates).toHaveLength(count);
});
