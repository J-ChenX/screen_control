import { afterEach, expect, test, vi } from "vitest";
import { createDownloadStorage } from "./downloadStorage";

afterEach(() => vi.unstubAllGlobals());

test("小文件保持字节内容，完成后可以释放", async () => {
  const store = await createDownloadStorage(3);
  await store.write(new Uint8Array([0, 123, 255]));
  const result = await store.finish("中文.bin");
  expect([...new Uint8Array(await result.file.arrayBuffer())]).toEqual([0, 123, 255]);
  await result.dispose();
});

test("大于 512 MB 的声明使用磁盘写入，释放时删除临时文件", async () => {
  const write = vi.fn(async () => {}), close = vi.fn(async () => {}), abort = vi.fn(async () => {});
  const removeEntry = vi.fn(async () => {});
  const handle = { createWritable: async () => ({ write, close, abort }), getFile: async () => new File(["内容"], "temp") };
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({ getFileHandle: async () => handle, removeEntry }) } });
  const store = await createDownloadStorage(513 * 1024 * 1024);
  await store.write(new Uint8Array([1, 2, 3]));
  expect(write).toHaveBeenCalledOnce();
  const result = await store.finish("result");
  expect(result.file.name).toBe("result");
  expect(close).toHaveBeenCalledOnce();
  await result.dispose(); await result.dispose();
  expect(removeEntry).toHaveBeenCalledOnce();
  expect(abort).not.toHaveBeenCalled();
});

test("中断会终止磁盘写入并清理，拒绝后续写入", async () => {
  const abort = vi.fn(async () => {}), removeEntry = vi.fn(async () => {});
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => ({ getFileHandle: async () => ({ createWritable: async () => ({ abort }) }), removeEntry }) } });
  const store = await createDownloadStorage(20 * 1024 * 1024);
  await store.dispose();
  await expect(store.write(new Uint8Array([1]))).rejects.toThrow("取消");
  expect(abort).toHaveBeenCalledOnce();expect(removeEntry).toHaveBeenCalledOnce();
});
