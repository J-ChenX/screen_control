import type { MeshDesktopModule } from '../meshcentral';

export type DesktopDisplays = { ids: number[]; selected: number | null; pending: number | null; error: string | null };
export const emptyDesktopDisplays: DesktopDisplays = { ids: [], selected: null, pending: null, error: null };

// 复用代理命令 11/12；65535 是合并桌面，只允许选择实际显示器。
export function manageDesktopDisplays(module: MeshDesktopModule, preferred: number | null, update: (state: DesktopDisplays) => void) {
  let state = { ...emptyDesktopDisplays };
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let desired = preferred;
  let geometry: { width: number; height: number }[] = [];
  const sourceSize = (id: number) => geometry[Math.max(0, id - 1)];
  const command = module.ProcessBinaryCommand?.bind(module);
  const picture = module.ProcessPictureMsg?.bind(module);
  const mouse = module.SendMouseMsg.bind(module), key = module.SendKeyMsgKC.bind(module), text = module.SendStringUnicode.bind(module);
  const ready = () => !disposed && state.selected !== null && state.pending === null && !state.error;
  const publish = () => update({ ...state });
  const timeout = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state = { ...state, pending: null, error: '屏幕选择未获确认，请重试。' };
      publish();
    }, 8000);
  };
  const select = (id: number) => {
    if (disposed || state.pending !== null || !state.ids.includes(id) || !module.SetDisplay) return;
    desired = id;
    state = { ...state, pending: id, error: null };
    module.ResetDesktopDisplay?.(true, sourceSize(id));
    publish(); timeout(); module.SetDisplay(id);
  };
  module.SendMouseMsg = (...args) => { if (ready()) mouse(...args); };
  module.SendKeyMsgKC = (...args) => { if (ready()) key(...args); };
  module.SendStringUnicode = value => { if (ready()) text(value); };
  if (picture) module.ProcessPictureMsg = (...args) => { if (ready()) picture(...args); };
  if (command) module.ProcessBinaryCommand = (code, size, data) => {
    // Windows 命令 82 按枚举顺序给出物理尺寸；选择编号也是该顺序，不能按 DISPLAY 名称排序。
    if (code === 82 && size >= 4 && size <= data.length && (size - 4) % 10 === 0) {
      const sizes = [];
      for (let offset = 4; offset < size; offset += 10) sizes.push({ width: data[offset + 6] * 256 + data[offset + 7], height: data[offset + 8] * 256 + data[offset + 9] });
      geometry = sizes.every(value => value.width > 0 && value.height > 0) ? sizes : [];
    }
    command(code, size, data);
  };
  module.onDisplayinfo = (_module, displays, selected) => {
    if (disposed) return;
    const wasReady = ready();
    const ids = Object.keys(displays).map(Number).filter(id => Number.isInteger(id) && id > 0 && id < 65535).sort((a, b) => a - b);
    // Windows 单屏使用空列表和 selected=0；0 仅用于这个协议特例。
    if (!ids.length && selected === 0) ids.push(0);
    const actual = ids.includes(selected) ? selected : null;
    state = { ...state, ids, selected: actual };
    if (state.pending !== null) {
      if (actual !== state.pending) { publish(); return; }
      clearTimeout(timer);
      state = { ...state, pending: null, error: null };
      module.ResetDesktopDisplay?.(true, sourceSize(actual));
      module.SendRefresh?.();
    } else if (ids.length && (actual === null || (desired !== null && ids.includes(desired) && actual !== desired))) {
      select(desired !== null && ids.includes(desired) ? desired : ids[0]);
      return;
    } else {
      clearTimeout(timer);
      state = { ...state, error: ids.length ? null : '未取得可用屏幕，请重试。' };
      if (!wasReady && actual !== null) { module.ResetDesktopDisplay?.(true, sourceSize(actual)); module.SendRefresh?.(); }
    }
    if (state.selected !== null) desired = state.selected;
    publish();
  };
  return {
    start() { if (!ready()) timeout(); module.GetDisplayNumbers?.(); },
    select,
    retry() {
      if (disposed) return;
      const id = desired !== null && state.ids.includes(desired) ? desired : state.ids[0];
      if (id !== undefined) select(id);
      else { state = { ...state, error: null }; publish(); timeout(); module.GetDisplayNumbers?.(); }
    },
    dispose() {
      disposed = true; clearTimeout(timer); module.onDisplayinfo = null;
      module.SendMouseMsg = mouse; module.SendKeyMsgKC = key; module.SendStringUnicode = text;
      if (picture) module.ProcessPictureMsg = picture;
      if (command) module.ProcessBinaryCommand = command;
    },
  };
}
