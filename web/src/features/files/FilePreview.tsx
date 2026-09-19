import { useEffect, useRef, useState } from "react";
import type { DownloadArtifact } from "./downloadStorage";

export const previewLimit = 16 * 1024 * 1024;
export function previewType(name: string): string | null {
  const extension = name.split(".").at(-1)?.toLowerCase() ?? "";
  const images: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", avif: "image/avif" };
  if (images[extension]) return images[extension];
  if (extension === "pdf") return "application/pdf";
  if (["txt", "md", "csv", "tsv", "json", "log", "yaml", "yml", "xml", "html", "css", "js", "ts", "py", "go", "ini", "conf"].includes(extension)) return "text/plain";
  return null;
}

export function FilePreview({ name, load, onClose }: { name: string; load: () => Promise<DownloadArtifact>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [content, setContent] = useState<{ url?: string; text?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const type = previewType(name);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    let disposed = false;
    let artifact: DownloadArtifact | undefined;
    let url: string | undefined;
    const timer = window.setTimeout(() => {
      if (!type) setError("此格式暂不支持临时预览，请关闭后下载，用本机应用查看。支持图片、PDF 和文本；Word、Excel、PowerPoint 暂不支持。");
      else void load().then(async result => {
        if (disposed) { await result.dispose(); return; }
        artifact = result;
        if (result.file.size > previewLimit) throw new Error("临时预览仅支持 16 MiB 以内的文件，请下载查看。");
        if (type === "text/plain") {
          const text = await result.file.text();
          if (!disposed) setContent({ text });
        } else {
          url = URL.createObjectURL(result.file.slice(0, result.file.size, type));
          setContent({ url });
        }
      }).catch((caught: unknown) => { if (!disposed) setError(caught instanceof Error ? caught.message : "预览读取失败"); });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      disposed = true;
      element.close();
      if (url) URL.revokeObjectURL(url);
      void artifact?.dispose().catch(() => undefined);
    };
  }, [load, type]);
  return <dialog ref={dialog} className="file-preview-dialog" aria-label={`预览 ${name}`} onCancel={event => { event.stopPropagation(); onClose(); }}>
    <header><strong title={name}>{name}</strong><button autoFocus onClick={onClose}>关闭预览</button></header>
    <div className="file-preview-body">
      {error ? <p role="alert">{error}</p> : content.text !== undefined ? <pre>{content.text}</pre> : content.url ? type?.startsWith("image/") ? <img src={content.url} alt={name} onError={() => setError("图片无法解码，请下载后查看。")} /> : <><p>若浏览器不支持 PDF 显示，请关闭后下载查看。</p><iframe title={`PDF 预览 ${name}`} src={content.url} /></> : <p role="status">正在读取临时预览…</p>}
    </div>
  </dialog>;
}
