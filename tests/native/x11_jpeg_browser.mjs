import { spawnSync } from "node:child_process";
import { launchBrowser } from "../support/browser.mjs";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const root = resolve(import.meta.dirname, "../..");
const binary = process.argv[2];
const mode = process.argv[3] ?? "center";
if (!binary) throw new Error("请传入已编译的 x11_jpeg_live 可执行文件");
if (!["top-left", "center", "bottom-right"].includes(mode)) throw new Error("未知 tile 位置");
const capture = spawnSync(binary, [mode], {
  cwd: root,
  env: { ...process.env, ASAN_OPTIONS: "detect_leaks=1:halt_on_error=1", UBSAN_OPTIONS: "halt_on_error=1" },
  maxBuffer: 8 * 1024 * 1024,
});
if (capture.status !== 0 || capture.error) {
  throw new Error(`候选采集失败：${capture.error?.message ?? capture.stderr.toString().trim()}`);
}
const data = capture.stdout;
if (data.length < 28 || data.toString("ascii", 0, 4) !== "SCJP") throw new Error("候选图像管道头无效");
const [jpegLength, rgbLength, width, height, x, y] = Array.from({ length: 6 }, (_, index) => data.readUInt32LE(4 + index * 4));
if (width !== 32 || height !== 32 || rgbLength !== 32 * 32 * 3 ||
    jpegLength < 100 || jpegLength > 65535 || data.length !== 28 + jpegLength + rgbLength) {
  throw new Error("候选图像管道长度或尺寸无效");
}
const jpeg = Array.from(data.subarray(28, 28 + jpegLength));
const expected = Array.from(data.subarray(28 + jpegLength));
const memorySource = readFileSync(resolve(root, "web/src/features/desktop/memory.ts"), "utf8");
const memoryScript = stripTypeScriptTypes(memorySource).replace("export function manageDesktopMemory", "function manageDesktopMemory") +
  "\nwindow.__manageDesktopMemory = manageDesktopMemory;\n";
const browser = await launchBrowser({ args: ["--force-color-profile=srgb"] });
let result;
try {
  const page = await browser.newPage();
  await page.addScriptTag({ content: memoryScript });
  result = await page.evaluate(async ({ jpeg, expected, width, height }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas 2D 不可用");
    let maxDifference = 0, sumDifference = 0, overEight = 0, decoded = 0, closed = 0;
    const nativeCreate = createImageBitmap;
    window.createImageBitmap = async (...args) => {
      const bitmap = await nativeCreate(...args);
      decoded++;
      return bitmap;
    };
    const nativeClose = ImageBitmap.prototype.close;
    ImageBitmap.prototype.close = function () { closed++; nativeClose.call(this); };
    const module = {
      State: 3, KillDraw: 0, PendingOperations: [], tilesReceived: 0, TilesDrawn: 0,
      ProcessPictureMsg() {}, SendPause() {}, SendUnPause() {}, SendRefresh() {},
      DoPendingOperations() {
        const operation = this.PendingOperations.shift();
        if (!operation) return false;
        if (operation[1] === 2) context.drawImage(operation[2], operation[3], operation[4]);
        this.TilesDrawn = operation[0];
        return true;
      },
    };
    const dispose = window.__manageDesktopMemory(module, canvas);
    const data = new Uint8Array(4 + jpeg.length);
    data.set(jpeg, 4);
    for (let pass = 0; pass < 32; pass++) {
      module.ProcessPictureMsg(data, 0, 0);
      const deadline = performance.now() + 2000;
      while ((module.TilesDrawn !== pass + 1 || closed !== pass + 1) && performance.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      if (module.TilesDrawn !== pass + 1 || closed !== pass + 1) throw new Error("图块绘制或位图释放超时");
      const actual = context.getImageData(0, 0, width, height).data;
      let channel = 0;
      for (let pixel = 0; pixel < width * height; pixel++) {
        for (let component = 0; component < 3; component++) {
          const difference = Math.abs(actual[pixel * 4 + component] - expected[channel++]);
          maxDifference = Math.max(maxDifference, difference);
          sumDifference += difference;
          overEight += Number(difference > 8);
        }
        if (actual[pixel * 4 + 3] !== 255) throw new Error("Chromium 画布 alpha 不完整");
      }
    }
    dispose();
    return { maxDifference, meanDifference: sumDifference / (decoded * width * height * 3),
      overEight, decoded, closed, canvasReleased: canvas.width === 1 && canvas.height === 1 };
  }, { jpeg, expected, width, height });
  await page.close();
} finally {
  await browser.close();
}
if (result.maxDifference > 8 || result.overEight !== 0 || result.decoded !== 32 ||
    result.closed !== 32 || !result.canvasReleased) {
  throw new Error(`浏览器图块绘制或释放检查失败：${JSON.stringify(result)}`);
}
console.log(JSON.stringify({ mode, width, height, x, y, jpegBytes: jpegLength, ...result, imagePersisted: false }));
