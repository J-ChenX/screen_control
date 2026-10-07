import { afterEach, describe, expect, it, vi } from "vitest";
import { installTouchInput } from "./touch";
import type { MeshDesktopModule } from "../meshcentral";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function setup() {
  vi.useFakeTimers();
  const canvas = new EventTarget() as HTMLCanvasElement;
  canvas.getBoundingClientRect = () => ({ left: 10, top: 20, right: 110, bottom: 120 }) as DOMRect;
  canvas.setPointerCapture = vi.fn();
  canvas.hasPointerCapture = () => true;
  canvas.releasePointerCapture = vi.fn();
  const browser = Object.assign(new EventTarget(), { scrollX: 0, scrollY: 0 });
  vi.stubGlobal("window", browser);
  const send = vi.fn(), zoomBy = vi.fn(), pan = vi.fn();
  const state = { enabled: true, moving: false };
  const module = { KeyAction: { NONE: 0, DOWN: 1, UP: 2 }, SendMouseMsg: send } as unknown as MeshDesktopModule;
  const cleanup = installTouchInput(canvas, module, () => true, { enabled: () => state.enabled, moving: () => state.moving, zoomBy, pan });
  const pointer = (type: string, id: number, x = 50, y = 60, pointerType = "touch") => {
    canvas.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { pointerId: id, pointerType, clientX: x, clientY: y }));
  };
  return { pointer, cleanup, send, zoomBy, pan, state, browser };
}

describe("触屏输入与画面手势", () => {
  it("轻触配对发送右键，忽略鼠标，清理后不再处理输入", () => {
    const s = setup();
    s.pointer("pointerdown", 9, 50, 60, "mouse");
    s.pointer("pointerdown", 1);
    expect(s.send).not.toHaveBeenCalled();
    s.pointer("pointerup", 1);
    expect(s.send.mock.calls).toEqual([[1, { pageX: 50, pageY: 60, button: 2 }], [2, { pageX: 50, pageY: 60, button: 2 }]]);
    s.cleanup(); s.pointer("pointerdown", 3); vi.runAllTimers();
    expect(s.send).toHaveBeenCalledTimes(2);
  });
  it("拖动越界后取消仍释放按键，待识别的取消不触发点击", () => {
    const s = setup();
    s.pointer("pointerdown", 1); s.pointer("pointermove", 1, 200); s.pointer("pointercancel", 1);
    expect(s.send.mock.calls).toEqual([[1, { pageX: 50, pageY: 60, button: 2 }], [0, { pageX: 109, pageY: 60, button: 2 }], [2, { pageX: 109, pageY: 60, button: 2 }]]);
    s.pointer("pointerdown", 2); s.pointer("pointercancel", 2); vi.runAllTimers();
    expect(s.send).toHaveBeenCalledTimes(3); s.cleanup();
  });
  it("双指缩放和平移不发送点击，抬起一指后不恢复远端拖动", () => {
    const s = setup();
    s.pointer("pointerdown", 1, 30); s.pointer("pointerdown", 2, 70);
    s.pointer("pointermove", 2, 90);
    expect(s.zoomBy).toHaveBeenCalledWith(1.5, { x: 50, y: 60 });
    expect(s.pan).toHaveBeenCalledWith({ x: 10, y: 0 });
    s.pointer("pointerup", 2, 90); s.pointer("pointermove", 1, 40); s.pointer("pointerup", 1, 40);
    vi.runAllTimers(); expect(s.send).not.toHaveBeenCalled(); s.cleanup();
  });
  it("长按后加入第二指先释放按键，失焦和清理不留下远端按下", () => {
    const s = setup();
    s.pointer("pointerdown", 1); vi.advanceTimersByTime(180); s.pointer("pointerdown", 2, 80);
    expect(s.send.mock.calls.map(call => call[0])).toEqual([1, 2]);
    s.browser.dispatchEvent(new Event("blur"));
    s.pointer("pointerdown", 3); vi.advanceTimersByTime(180); s.cleanup();
    expect(s.send.mock.calls.map(call => call[0])).toEqual([1, 2, 1, 2]);
  });
  it("移动模式只平移，暂停输入时不发送点击或重放待识别操作", () => {
    const s = setup(); s.state.moving = true;
    s.pointer("pointerdown", 1); s.pointer("pointermove", 1, 70); s.pointer("pointerup", 1, 70);
    expect(s.pan).toHaveBeenCalledWith({ x: 20, y: 0 }); expect(s.send).not.toHaveBeenCalled();
    s.state.moving = false; s.pointer("pointerdown", 2); s.state.enabled = false; vi.runAllTimers();
    s.pointer("pointerup", 2); s.pointer("pointerdown", 3); s.state.enabled = true; vi.runAllTimers();
    expect(s.send).not.toHaveBeenCalled(); s.cleanup();
  });
});
