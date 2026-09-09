import type { MeshDesktopModule } from "../meshcentral";

// 指针捕获确保拖动在画布外结束时仍能配对发送 UP 事件。
export function installTouchInput(canvas: HTMLCanvasElement, module: MeshDesktopModule, rightClick: () => boolean) {
  let pointer: number | null = null;
  let button = 0;
  let last = { pageX: 0, pageY: 0, button: 0 };
  const position = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return {
      pageX: Math.max(rect.left + 1, Math.min(rect.right - 1, event.clientX)) + window.scrollX,
      pageY: Math.max(rect.top + 1, Math.min(rect.bottom - 1, event.clientY)) + window.scrollY,
      button,
    };
  };
  const down = (event: PointerEvent) => {
    if (event.pointerType === "mouse") return;
    event.preventDefault();
    if (pointer !== null) return;
    pointer = event.pointerId;
    button = rightClick() ? 2 : 0;
    last = position(event);
    canvas.setPointerCapture(pointer);
    module.SendMouseMsg(module.KeyAction.DOWN, last);
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return;
    event.preventDefault();
    last = position(event);
    module.SendMouseMsg(module.KeyAction.NONE, last);
  };
  const release = () => {
    if (pointer === null) return;
    const id = pointer;
    pointer = null;
    module.SendMouseMsg(module.KeyAction.UP, last);
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  };
  const up = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return;
    event.preventDefault();
    release();
  };
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("lostpointercapture", up);
  window.addEventListener("blur", release);
  return () => {
    release();
    canvas.removeEventListener("pointerdown", down);
    canvas.removeEventListener("pointermove", move);
    canvas.removeEventListener("pointerup", up);
    canvas.removeEventListener("pointercancel", up);
    canvas.removeEventListener("lostpointercapture", up);
    window.removeEventListener("blur", release);
  };
}
