import { changeFolderFavorites, getFolderFavorites, type FavoriteChange } from "../../api/client";
import { useEffect, useRef, useState } from "react";

const prefix = "screen-control:folder-favorites:";
const changed = "screen-control:folder-favorites-changed";
export function parseFavorites(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(value) ? [...new Set(value.filter((path): path is string => typeof path === "string" && path.length > 0 && !path.includes("\0")))] : [];
  } catch { return []; }
}

// 插入点基于移动前的列表；移除旧位置后校正索引，重复拖入不会产生副本。
export function placeFavorite(current: string[], path: string, index = current.length): string[] {
  const previous = current.indexOf(path);
  const next = current.filter(item => item !== path);
  const position = Math.max(0, Math.min(next.length, index - (previous >= 0 && previous < index ? 1 : 0)));
  next.splice(position, 0, path);
  return next;
}

export function useFolderFavorites(deviceId: string) {
  const [favorites, setFavorites] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const writing = useRef(false);
  const current = useRef<string[]>([]);
  const epoch = useRef(0);
  const mounted = useRef(false);
  const accept = (paths: string[]) => { current.current = paths; setFavorites(paths); };
  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    let reading = false;
    const abort = new AbortController();
    const sync = async () => {
      if (reading || writing.current || stopped || document.hidden) return;
      reading = true;
      const version = epoch.current;
      try {
        let result = await getFolderFavorites(deviceId, abort.signal);
        // 仅迁移一次旧浏览器收藏；服务器记录迁移标识，响应丢失也不会重复合并。
        const key = prefix + deviceId;
        let legacy: string[] = [];
        try { legacy = parseFavorites(localStorage.getItem(key)); } catch { /* 本地存储不可用不影响同步。 */ }
        if (legacy.length && !stopped && version === epoch.current) {
          const tokenKey = key + ":import-id";
          let token = localStorage.getItem(tokenKey);
          if (!token) {
            const bytes = crypto.getRandomValues(new Uint8Array(16));
            token = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
            localStorage.setItem(tokenKey, token);
          }
          result = await changeFolderFavorites(deviceId, { action: "import", paths: legacy, importId: token });
          try { localStorage.removeItem(key); } catch { /* 服务端幂等记录防止再次导入。 */ }
        }
        if (!stopped && version === epoch.current && !writing.current) {
          accept(result.paths); setReady(true); setSyncError(null);
        }
      } catch (caught) {
        if (!stopped && version === epoch.current) setSyncError(caught instanceof Error ? caught.message : "收藏同步失败");
      } finally { reading = false; }
    };
    void sync();
    const refresh = () => { void sync(); };
    const timer = window.setInterval(refresh, 3000);
    window.addEventListener("focus", refresh);
    window.addEventListener(changed, refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      stopped = true; mounted.current = false; abort.abort(); window.clearInterval(timer);
      window.removeEventListener("focus", refresh); window.removeEventListener(changed, refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [deviceId]);
  const save = async (change: FavoriteChange) => {
    if (writing.current || !ready) return;
    writing.current = true; epoch.current++; setPending(true); setWriteError(null);
    try {
      const result = await changeFolderFavorites(deviceId, change);
      if (mounted.current) accept(result.paths);
    } catch (caught) {
      if (mounted.current) setWriteError(`${caught instanceof Error ? caught.message : "收藏保存失败"}；未确认保存，未自动重试。`);
    } finally {
      writing.current = false;
      if (mounted.current) setPending(false);
      window.dispatchEvent(new Event(changed));
    }
  };
  const toggle = (path: string) => save({ action: current.current.includes(path) ? "remove" : "add", path });
  const place = (path: string, index = current.current.length) => {
    const next = placeFavorite(current.current, path, index);
    return save({ action: "move", path, before: next[next.indexOf(path) + 1] ?? "" });
  };
  return { favorites, toggle, place, syncError: writeError ?? syncError, syncing: pending || !ready };
}
