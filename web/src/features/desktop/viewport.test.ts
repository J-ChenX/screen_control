import { expect, it, vi } from "vitest";
import { createDesktopViewport } from "./viewport";

it("缩放以触点为中心，移动有边界，旋转后保留倍率，适应恢复完整画面", () => {
  const canvas = { width: 1920, height: 1080, style: {} } as HTMLCanvasElement;
  const viewport = { clientWidth: 400, clientHeight: 300, getBoundingClientRect: () => ({ left: 10, top: 20 }) } as HTMLElement;
  const zoom = vi.fn();
  const view = createDesktopViewport(canvas, viewport, zoom);
  view.fit();
  expect(canvas.style).toMatchObject({ width: "400px", height: "225px", left: "0px", top: "37.5px" });
  view.zoomBy(2, { x: 110, y: 170 });
  expect(canvas.style).toMatchObject({ width: "800px", left: "-100px", top: "-75px" });
  view.pan({ x: 10000, y: -10000 });
  expect(canvas.style).toMatchObject({ left: "0px", top: "-150px" });
  Object.assign(viewport, { clientWidth: 800, clientHeight: 400 }); view.fit();
  expect(canvas.style.width).toBe("1422px");
  view.zoomBy(100); expect(zoom).toHaveBeenLastCalledWith(8);
  view.reset();
  expect(canvas.style).toMatchObject({ width: "711px", height: "400px", left: "44.5px", top: "0px" });
  view.zoomBy(.01); expect(zoom).toHaveBeenLastCalledWith(1);
});
