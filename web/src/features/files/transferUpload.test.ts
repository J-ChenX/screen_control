import { expect, test, vi } from "vitest";
import { createUploadPump } from "./transferUpload";

test("窗口有界，重复确认不扩窗，全部写入确认后才提交", async () => {
  let remaining = 20;
  const read = vi.fn(async () => remaining-- > 0 ? new Uint8Array([1]) : null);
  const send = vi.fn(), commit = vi.fn();
  const pump = createUploadPump(20, read, send, commit, vi.fn(), () => true);
  await pump.start({ window: 8, chunkSize: 262144 });
  expect(send).toHaveBeenCalledTimes(8); expect(commit).not.toHaveBeenCalled();
  await pump.acknowledge(0); expect(send).toHaveBeenCalledTimes(8);
  await pump.acknowledge(4); expect(send).toHaveBeenCalledTimes(12);
  await pump.acknowledge(4); expect(send).toHaveBeenCalledTimes(12);
  await expect(pump.acknowledge(13)).rejects.toThrow("累计确认");
  await pump.acknowledge(12); expect(send).toHaveBeenCalledTimes(20);
  await pump.acknowledge(19); expect(commit).not.toHaveBeenCalled();
  await pump.acknowledge(20); expect(commit).toHaveBeenCalledOnce();
  await pump.acknowledge(20); expect(commit).toHaveBeenCalledOnce();
});

test("旧端逐块确认和空文件保持兼容", async () => {
  for (const size of [0, 1]) {
    let remaining = size;
    const commit = vi.fn(), send = vi.fn();
    const pump = createUploadPump(size, async () => remaining-- > 0 ? new Uint8Array([1]) : null, send, commit, vi.fn(), () => true);
    await pump.start({});
    expect(send).toHaveBeenCalledTimes(size);
    if (size) { expect(commit).not.toHaveBeenCalled(); await pump.acknowledge(undefined); }
    expect(commit).toHaveBeenCalledOnce();
  }
});

test("异步读取期间取消不发送，短读不提交", async () => {
  let active = true, resolve!: (value: Uint8Array) => void;
  const send = vi.fn(), commit = vi.fn();
  const pump = createUploadPump(1, () => new Promise(done => { resolve = done; }), send, commit, vi.fn(), () => active);
  const started = pump.start({ window: 8, chunkSize: 262144 });
  active = false; resolve(new Uint8Array([1])); await started;
  expect(send).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
  const short = createUploadPump(1, async () => null, send, commit, vi.fn(), () => true);
  await expect(short.start({})).rejects.toThrow("不完整"); expect(commit).not.toHaveBeenCalled();
});
