import type { MeshDesktopModule } from "../meshcentral";
import type { ViewPoint } from "./viewport";

type TouchView = {
  enabled: () => boolean;
  moving: () => boolean;
  zoomBy: (factor: number, anchor: ViewPoint) => void;
  pan: (delta: ViewPoint) => void;
};

// 延迟单指按下以识别双指手势；捕获和取消处理确保远端按键成对释放。
export function installTouchInput(canvas: HTMLCanvasElement, module: MeshDesktopModule, rightClick: () => boolean, view: TouchView) {
  const pointers = new Map<number, ViewPoint>();
  let pressed = false;
  let gesture = false;
  let button = 0;
  let last = { pageX: 0, pageY: 0, button: 0 };
  let start = { x: 0, y: 0 };
  let pending: ReturnType<typeof setTimeout> | undefined;
  const clearPending = () => { clearTimeout(pending); pending = undefined; };
  const position = (point: ViewPoint) => {
    const rect = canvas.getBoundingClientRect();
    return {
      pageX: Math.max(rect.left + 1, Math.min(rect.right - 1, point.x)) + window.scrollX,
      pageY: Math.max(rect.top + 1, Math.min(rect.bottom - 1, point.y)) + window.scrollY,
      button,
    };
  };
  const press = () => {
    clearPending();
    if (!view.enabled() || gesture || view.moving() || pressed || pointers.size !== 1) return;
    pressed = true;
    module.SendMouseMsg(module.KeyAction.DOWN, last);
  };
  const release = () => {
    clearPending();
    if (!pressed) return;
    pressed = false;
    module.SendMouseMsg(module.KeyAction.UP, last);
  };
  const pair = () => {
    const [a, b] = [...pointers.values()];
    return { center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.hypot(a.x - b.x, a.y - b.y) };
  };
  const down = (event: PointerEvent) => {
    if (event.pointerType === "mouse" || !view.enabled()) return;
    event.preventDefault();
    const point = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, point);
    canvas.setPointerCapture(event.pointerId);
    if (pointers.size > 1) { release(); gesture = true; return; }
    start = point;
    button = rightClick() ? 2 : 0;
    last = position(point);
    pending = setTimeout(press, 180);
  };
  const move = (event: PointerEvent) => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    event.preventDefault();
    if (!view.enabled()) { cancel(); return; }
    const before = pointers.size >= 2 ? pair() : null;
    const point = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, point);
    if (before) {
      const after = pair();
      if (before.distance > 0 && after.distance > 0) view.zoomBy(after.distance / before.distance, before.center);
      view.pan({ x: after.center.x - before.center.x, y: after.center.y - before.center.y });
    } else if (gesture) {
      // 双指结束后的剩余手指不产生新的远端操作。
      return;
    } else if (view.moving()) {
      release();
      view.pan({ x: point.x - previous.x, y: point.y - previous.y });
    } else {
      if (Math.hypot(point.x - start.x, point.y - start.y) >= 8) press();
      last = position(point);
      if (pressed) module.SendMouseMsg(module.KeyAction.NONE, last);
    }
  };
  const up = (event: PointerEvent) => {
    if (!pointers.has(event.pointerId)) return;
    event.preventDefault();
    if (event.type === "pointerup" && !gesture && !view.moving() && view.enabled()) {
      press();
      last = position({ x: event.clientX, y: event.clientY });
    }
    release();
    pointers.delete(event.pointerId);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (!pointers.size) gesture = false;
  };
  const cancel = () => {
    release();
    const ids = [...pointers.keys()];
    pointers.clear();
    gesture = false;
    for (const id of ids) if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  };
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("lostpointercapture", up);
  window.addEventListener("blur", cancel);
  return () => {
    cancel();
    canvas.removeEventListener("pointerdown", down);
    canvas.removeEventListener("pointermove", move);
    canvas.removeEventListener("pointerup", up);
    canvas.removeEventListener("pointercancel", up);
    canvas.removeEventListener("lostpointercapture", up);
    window.removeEventListener("blur", cancel);
  };
}
