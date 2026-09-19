import { normalizeDirectoryPath } from "./MeshFiles";
import { describe, expect, it } from "vitest";
import { fileKind } from "./FileIcon";
import { parseFavorites, placeFavorite } from "./favorites";

describe("文件类型识别", () => {
  it.each([["PHOTO.JPG", "image"], ["movie.mkv", "video"], ["song.flac", "audio"], ["report.pdf", "pdf"], ["notes.md", "document"], ["data.csv", "sheet"], ["slides.pptx", "slides"], ["backup.tar.gz", "archive"], ["app.tsx", "code"], [".bashrc", "config"], [".env.local", "config"], ["Dockerfile", "code"], ["setup.exe", "app"], ["unknown", "file"]])("%s 显示 %s 图标", (name, kind) => expect(fileKind(name)[0]).toBe(kind));
});
describe("收藏存储恢复", () => {
  it("忽略损坏的存储与无效路径，保留顺序并去重", () => {
    expect(parseFavorites("bad")).toEqual([]);
    expect(parseFavorites('{}')).toEqual([]);
    expect(parseFavorites('["home/a",null,5,"home/a","","C:/资料"]')).toEqual(["home/a", "C:/资料"]);
  });
});

describe("收藏拖动顺序", () => {
  it("向前、向后移动和新增到指定位置，保持来源列表不变", () => {
    const current = ["a", "b", "c"];
    expect(placeFavorite(current, "c", 0)).toEqual(["c", "a", "b"]);
    expect(placeFavorite(current, "a", 3)).toEqual(["b", "c", "a"]);
    expect(placeFavorite(current, "d", 1)).toEqual(["a", "d", "b", "c"]);
    expect(placeFavorite(current, "b", 2)).toEqual(current);
    expect(placeFavorite(current, "b")).toEqual(["a", "c", "b"]);
    expect(current).toEqual(["a", "b", "c"]);
  });
});

describe("Windows 目录地址", () => {
  it("保留盘符根目录的绝对路径语义，并兼容手动输入裸盘符", () => {
    for (const path of ["C:", "C:/", "C:\\"]) expect(normalizeDirectoryPath(path, true)).toBe("C:/");
    expect(normalizeDirectoryPath("D:/资料/", true)).toBe("D:/资料");
    expect(normalizeDirectoryPath("", true)).toBe("");
    expect(normalizeDirectoryPath("/home/demo/", false)).toBe("home/demo");
  });
});
