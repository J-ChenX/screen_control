import { describe, expect, it, vi } from "vitest";
import { installTouchInput } from "./touch";
import type { MeshDesktopModule } from "../meshcentral";

describe("touch input", () => {
  it("pairs captured drags with release on cancellation and ignores mouse/second finger", () => {
    const canvas = new EventTarget() as HTMLCanvasElement;
    canvas.getBoundingClientRect = () => ({ left: 10, top: 20, right: 110, bottom: 120 }) as DOMRect;
    canvas.setPointerCapture = vi.fn();
    canvas.hasPointerCapture = () => true;
    canvas.releasePointerCapture = vi.fn();
    const browser = Object.assign(new EventTarget(), { scrollX: 0, scrollY: 0 });
    vi.stubGlobal("window", browser);
    const send = vi.fn();
    const module = { KeyAction: { NONE: 0, DOWN: 1, UP: 2 }, SendMouseMsg: send } as unknown as MeshDesktopModule;
    const cleanup = installTouchInput(canvas, module, () => true);
    const pointer = (type: string, id: number, pointerType = "touch", x = 50) => {
      canvas.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { pointerId: id, pointerType, clientX: x, clientY: 60 }));
    };
    pointer("pointerdown", 9, "mouse");
    expect(send).not.toHaveBeenCalled();
    pointer("pointerdown", 1);
    pointer("pointerdown", 2);
    pointer("pointermove", 1, "touch", 200);
    pointer("pointercancel", 1);
    cleanup();
    expect(send.mock.calls).toEqual([[1, { pageX: 50, pageY: 60, button: 2 }], [0, { pageX: 109, pageY: 60, button: 2 }], [2, { pageX: 109, pageY: 60, button: 2 }]]);
    pointer("pointerdown", 3);
    expect(send).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });
});
