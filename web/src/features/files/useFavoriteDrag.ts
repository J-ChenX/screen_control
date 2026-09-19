import { useEffect, useRef, useState, type DragEvent, type PointerEvent } from "react";

// 只接受当前面板已知的文件夹；不读取外部拖入的路径或文件。
export function useFavoriteDrag(disabled: boolean, count: number, place: (path: string, index?: number) => void) {
  const pane = useRef<HTMLElement>(null);
  const source = useRef<{ path: string; x?: number; y?: number; dragging: boolean } | null>(null);
  const suppressClickUntil = useRef(0);
  const [cover, setCover] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [target, setTarget] = useState<number | null>(null);
  const reset = () => { source.current = null; setTarget(null); setDragging(false); };
  useEffect(() => { if (disabled) reset(); }, [disabled]);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => { if (event.key === "Escape") reset(); };
    window.addEventListener("keydown", cancel);
    window.addEventListener("blur", reset);
    return () => { window.removeEventListener("keydown", cancel); window.removeEventListener("blur", reset); };
  }, []);
  const position = (x: number, y: number) => {
    const bounds = pane.current?.getBoundingClientRect();
    if (!bounds || x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null;
    // 按整栏和行中线判断，不要求命中图标、文本或狭窄的插入线。
    const items = pane.current!.querySelectorAll<HTMLElement>("[data-favorite-index]");
    for (const item of items) {
      const row = item.getBoundingClientRect();
      if (y < row.top + row.height / 2) return Number(item.dataset.favoriteIndex);
    }
    return count;
  };
  const start = (event: DragEvent, path: string) => {
    if (disabled) { event.preventDefault(); return; }
    source.current = { path, dragging: true };
    // 排序时保留原拖动源的命中，避免浏览器取消正在开始的拖动。
    setCover(!pane.current?.contains(event.currentTarget));
    setDragging(true);
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData("application/x-screen-control-folder", "folder");
  };
  const scrollAtEdge = (x: number, y: number) => {
    const bounds = pane.current?.getBoundingClientRect();
    const scroller = pane.current?.querySelector(".file-favorites-scroll");
    if (!bounds || x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return;
    if (y < bounds.top + 35) scroller?.scrollBy(0, -12);
    if (y > bounds.bottom - 35) scroller?.scrollBy(0, 12);
  };
  const over = (event: DragEvent) => {
    if (disabled || !source.current) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setTarget(position(event.clientX, event.clientY));
    scrollAtEdge(event.clientX, event.clientY);
  };
  const drop = (event: DragEvent) => {
    if (!source.current || disabled) return;
    event.preventDefault();
    const index = position(event.clientX, event.clientY);
    if (index !== null) place(source.current.path, index);
    reset();
  };
  const touchStart = (event: PointerEvent, path: string) => {
    if (event.pointerType !== "touch" || disabled) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    source.current = { path, x: event.clientX, y: event.clientY, dragging: false };
  };
  const touchMove = (event: PointerEvent) => {
    const active = source.current;
    if (event.pointerType !== "touch" || disabled || active?.x === undefined || active.y === undefined) return;
    if (Math.hypot(event.clientX - active.x, event.clientY - active.y) > 6) active.dragging = true;
    if (active.dragging) {
      setDragging(true);
      suppressClickUntil.current = Date.now() + 500;
      setTarget(position(event.clientX, event.clientY));
      // 接近收藏栏边缘时滚动，长列表仍可调整到首尾。
      scrollAtEdge(event.clientX, event.clientY);
    }
  };
  const touchEnd = (event: PointerEvent) => {
    if (event.pointerType !== "touch") return;
    const active = source.current;
    const index = position(event.clientX, event.clientY);
    if (!disabled && active?.dragging && index !== null) place(active.path, index);
    reset();
  };
  return { pane, dragging, cover, cancelTouch: (event: PointerEvent) => { if (event.pointerType === "touch") reset(); }, target, start, over, drop, reset, leave: () => setTarget(null), touchStart, touchMove, touchEnd,
    suppressClick: () => Date.now() < suppressClickUntil.current };
}
