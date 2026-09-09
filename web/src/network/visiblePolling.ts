// 仅在页面可见时轮询。页面隐藏时中止并丢弃请求，
// 快速切换隐藏与显示以及 React 副作用清理时也遵循此规则。
export function startVisiblePolling(refresh: (signal: AbortSignal) => Promise<void>, intervalMs = 5000): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: AbortController | null = null;
  const clearTimer = () => { clearTimeout(timer); timer = undefined; };
  const pause = () => {
    clearTimer();
    current?.abort();
    current = null;
  };
  const run = async () => {
    if (stopped || document.visibilityState !== "visible" || current) return;
    clearTimer();
    const controller = new AbortController();
    current = controller;
    try { await refresh(controller.signal); }
    catch { /* 由调用方报告错误；取消请求不得导致轮询停止。 */ }
    finally {
      if (current === controller) {
        current = null;
        if (!stopped && document.visibilityState === "visible") timer = setTimeout(() => void run(), intervalMs);
      }
    }
  };
  const visibilityChanged = () => {
    if (document.visibilityState !== "visible") pause();
    else void run();
  };
  const online = () => { void run(); };
  document.addEventListener("visibilitychange", visibilityChanged);
  window.addEventListener("online", online);
  void run();
  return () => {
    stopped = true;
    pause();
    document.removeEventListener("visibilitychange", visibilityChanged);
    window.removeEventListener("online", online);
  };
}
