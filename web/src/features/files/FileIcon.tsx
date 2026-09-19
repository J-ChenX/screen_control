const kinds = [
  ["image", "图片", "jpg jpeg png gif webp svg bmp ico heic avif tiff"],
  ["video", "视频", "mp4 mkv mov avi webm m4v wmv"],
  ["audio", "音频", "mp3 wav flac aac ogg m4a opus"],
  ["pdf", "PDF", "pdf"],
  ["document", "文档", "doc docx odt rtf txt md log rst"],
  ["sheet", "表格", "xls xlsx csv tsv ods"],
  ["slides", "演示文稿", "ppt pptx odp"],
  ["archive", "压缩包", "zip rar 7z tar gz bz2 xz tgz zst"],
  ["code", "代码", "js jsx ts tsx py go rs java c cpp h hpp cs html css scss sh bash ps1 bat sql vue svelte rb php"],
  ["config", "配置", "json yaml yml toml ini conf config env xml lock"],
  ["app", "程序", "exe msi deb rpm appimage apk dmg iso bin"],
] as const;
export function fileKind(name: string) {
  const lower = name.toLowerCase();
  const extension = lower.split(".").at(-1) ?? "";
  if (["dockerfile", "makefile"].includes(lower)) return kinds[8];
  if (/^\.(bashrc|zshrc|profile|gitignore|npmrc|env)(\.|$)/.test(lower)) return kinds[9];
  return kinds.find(([, , extensions]) => extensions.split(" ").includes(extension)) ?? ["file", "文件", ""];
}
const symbols: Record<string, string> = {
  image: "M7 23l5-6 4 4 3-3 3 5M11 12h.01", video: "M10 13l10 6-10 6Z",
  audio: "M12 23V13l8-2v10M12 22c-6-3-6 5 0 2M20 20c-6-3-6 5 0 2",
  document: "M7 14h12M7 19h12M7 24h8", sheet: "M7 13h13v12H7ZM7 17h13M7 21h13M12 13v12",
  slides: "M7 13h13v10H7ZM13 23v4M9 27h8", archive: "M13 10h3v3h-3v3h3v3h-3v3h3v4h-3",
  code: "M10 14l-4 5 4 5M18 14l4 5-4 5M16 12l-4 14", config: "M7 14h14M7 23h14M11 11v6M17 20v6",
  app: "M7 13h14v12H7ZM7 17h14M10 15h.01", file: "M8 16h10M8 21h7",
};
export function FileIcon({ name, folder = false, favorite = false }: { name: string; folder?: boolean; favorite?: boolean }) {
  const [kind] = fileKind(name);
  return <span className={`entry-icon ${folder ? "entry-folder-icon" : `entry-file-icon entry-kind-${kind}`} ${favorite ? "entry-favorite-icon" : ""}`} aria-hidden="true">
    {folder ? <svg viewBox="0 0 32 26"><path d="M2 6.5h11l3-4h6.5c2 0 3.5 1.5 3.5 3.5v2H2Z"/><path d="M2 7h27a2 2 0 0 1 2 2.3l-2 12.2a3 3 0 0 1-3 2.5H5a3 3 0 0 1-3-3Z"/>{favorite && <path className="folder-star" d="m17 10 1.8 3.6 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4-2.9-2.8 4-.6Z"/>}</svg>
      : <svg viewBox="0 0 26 32"><path d="M4 1h11l7 7v21a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2Z"/><path d="M15 1v8h7"/>{kind === "pdf" ? <text x="4" y="23" className="file-icon-label">PDF</text> : <path className="file-type-symbol" d={symbols[kind]}/>}</svg>}
  </span>;
}
