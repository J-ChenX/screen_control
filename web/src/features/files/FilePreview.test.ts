import { describe, expect, it } from "vitest";
import { previewType } from "./FilePreview";

describe("临时预览格式边界", () => {
  it("图片和 PDF 使用明确 MIME", () => {
    expect(previewType("照片.JPEG")).toBe("image/jpeg");
    expect(previewType("说明.pdf")).toBe("application/pdf");
  });
  it("活动内容只作为纯文本，不执行 HTML 或脚本", () => {
    expect(previewType("页面.html")).toBe("text/plain");
    expect(previewType("脚本.js")).toBe("text/plain");
    expect(previewType("图.svg")).toBeNull();
    expect(previewType("报表.xlsx")).toBeNull();
    expect(previewType("图片.png.exe")).toBeNull();
  });
});
