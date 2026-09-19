import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

const rowHeight = 116;

// 大目录仅挂载可见行与少量预留行；方向键负责跨越尚未挂载的项目。
export function VirtualFileGrid({ count, label, resetKey, render, empty }: {
  count: number; label: string; resetKey: string;
  render: (index: number, tabIndex: number | undefined) => ReactNode;
  empty: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<number | null>(null);
  const [focus, setFocus] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 600, columns: 1 });
  const active = count > 300;
  useLayoutEffect(() => {
    const element = root.current!;
    const update = () => {
      const css = getComputedStyle(element);
      const width = element.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
      const minimum = parseFloat(css.getPropertyValue("--file-grid-min")) || 82;
      const columns = Math.max(1, Math.floor((width + 4) / (minimum + 4)));
      const top = Math.floor(element.scrollTop / rowHeight);
      setViewport(previous => previous.top === top && previous.height === element.clientHeight && previous.columns === columns ? previous : { top, height: element.clientHeight, columns });
    };
    const observer = new ResizeObserver(update);
    observer.observe(element); element.addEventListener("scroll", update, { passive: true }); update();
    return () => { observer.disconnect(); element.removeEventListener("scroll", update); };
  }, []);
  useLayoutEffect(() => { root.current!.scrollTop = 0; setFocus(0); pendingFocus.current = null; setViewport(value => ({ ...value, top: 0 })); }, [resetKey]);
  const rows = Math.ceil(count / viewport.columns);
  const startRow = active ? Math.min(Math.max(0, rows - 1), Math.max(0, viewport.top - 2)) : 0;
  const endRow = active ? Math.min(rows, startRow + Math.ceil(viewport.height / rowHeight) + 5) : rows;
  const start = startRow * viewport.columns;
  const end = active ? Math.min(count, endRow * viewport.columns) : count;
  useLayoutEffect(() => {
    if (pendingFocus.current === null) return;
    const button = root.current!.querySelector<HTMLButtonElement>(`[data-file-index="${pendingFocus.current}"]`);
    if (button) { button.focus({ preventScroll: true }); pendingFocus.current = null; }
  }, [focus, start, end]);
  return <div ref={root} className="file-icon-grid" style={active ? { display: "block" } : undefined} role="listbox" aria-multiselectable="true" aria-description="Ctrl/⌘ 点选增减选择，Shift 连选；方向键浏览大目录" aria-label={label}
    onFocus={event => { const index = (event.target as HTMLElement).closest<HTMLElement>("[data-file-index]")?.dataset.fileIndex; if (index !== undefined) setFocus(Number(index)); }}
    onKeyDown={event => {
      if (!active || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const index = (event.target as HTMLElement).closest<HTMLElement>("[data-file-index]")?.dataset.fileIndex;
      if (index === undefined) return;
      const current = Number(index);
      const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -viewport.columns, ArrowDown: viewport.columns, PageUp: -Math.max(1, Math.floor(viewport.height / rowHeight)) * viewport.columns, PageDown: Math.max(1, Math.floor(viewport.height / rowHeight)) * viewport.columns };
      const next = event.key === "Home" ? 0 : event.key === "End" ? count - 1 : event.key in steps ? Math.max(0, Math.min(count - 1, current + steps[event.key])) : null;
      if (next === null) return;
      event.preventDefault(); pendingFocus.current = next; setFocus(next);
      const row = Math.floor(next / viewport.columns);
      if (row < viewport.top || (row + 1) * rowHeight > root.current!.scrollTop + viewport.height) root.current!.scrollTop = row * rowHeight;
      setViewport(value => ({ ...value, top: Math.floor(root.current!.scrollTop / rowHeight) }));
    }}>
    {active && <div aria-hidden="true" style={{ height: startRow * rowHeight }} />}
    <div style={active ? { display: "grid", gridTemplateColumns: `repeat(${viewport.columns}, minmax(0, 1fr))`, gridAutoRows: 112, gap: 4 } : { display: "contents" }}>
      {Array.from({ length: end - start }, (_, offset) => render(start + offset, active ? (start + offset === (focus >= start && focus < end ? focus : start) ? 0 : -1) : undefined))}
      {empty}
    </div>
    {active && <div aria-hidden="true" style={{ height: (rows - endRow) * rowHeight }} />}
  </div>;
}
