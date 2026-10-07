export type ViewPoint = { x: number; y: number };

export function fitRemoteCanvas(screenWidth: number, screenHeight: number, viewportWidth: number, viewportHeight: number) {
  if (screenWidth <= 0 || screenHeight <= 0 || viewportWidth <= 0 || viewportHeight <= 0) return { width: 0, height: 0 };
  const scale = Math.min(viewportWidth / screenWidth, viewportHeight / screenHeight);
  return { width: Math.round(screenWidth * scale), height: Math.round(screenHeight * scale) };
}

// 改变实际 CSS 尺寸与位置，保持协议组件按 clientWidth/offsetLeft 映射输入。
export function createDesktopViewport(canvas: HTMLCanvasElement, viewport: HTMLElement, onZoom: (zoom: number) => void) {
  let zoom = 1;
  let offset = { x: 0, y: 0 };
  let width = 0;
  let height = 0;
  const render = () => {
    const limitX = Math.max(0, (width * zoom - viewport.clientWidth) / 2);
    const limitY = Math.max(0, (height * zoom - viewport.clientHeight) / 2);
    offset = { x: Math.max(-limitX, Math.min(limitX, offset.x)), y: Math.max(-limitY, Math.min(limitY, offset.y)) };
    Object.assign(canvas.style, {
      width: `${width * zoom}px`, height: `${height * zoom}px`,
      left: `${(viewport.clientWidth - width * zoom) / 2 + offset.x}px`,
      top: `${(viewport.clientHeight - height * zoom) / 2 + offset.y}px`,
    });
  };
  const zoomBy = (factor: number, anchor?: ViewPoint) => {
    const rect = viewport.getBoundingClientRect();
    const x = anchor ? anchor.x - rect.left : viewport.clientWidth / 2;
    const y = anchor ? anchor.y - rect.top : viewport.clientHeight / 2;
    const next = Math.max(1, Math.min(8, zoom * factor));
    const ratio = next / zoom;
    offset = {
      x: (x - viewport.clientWidth / 2) * (1 - ratio) + offset.x * ratio,
      y: (y - viewport.clientHeight / 2) * (1 - ratio) + offset.y * ratio,
    };
    zoom = next;
    render();
    onZoom(zoom);
  };
  const pan = (delta: ViewPoint) => { offset.x += delta.x; offset.y += delta.y; render(); };
  return {
    fit() {
      if (!canvas.width || !canvas.height || !viewport.clientWidth || !viewport.clientHeight) return;
      ({ width, height } = fitRemoteCanvas(canvas.width, canvas.height, viewport.clientWidth, viewport.clientHeight));
      render();
    },
    zoomBy,
    pan,
    reset() { zoom = 1; offset = { x: 0, y: 0 }; render(); onZoom(zoom); },
  };
}
