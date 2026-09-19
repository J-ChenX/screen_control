import { expect, test, vi } from "vitest";
import { createTransferPipe } from "./transferStream";

test("按接收端读取需求拉取数据，不预取下一块", async () => {
  const request = vi.fn(), cancel = vi.fn();
  const pipe = createTransferPipe("file", 4, request, cancel);
  expect(request).not.toHaveBeenCalled();
  const first = pipe.source.read(); expect(request).toHaveBeenLastCalledWith(true);
  pipe.accept(new Uint8Array([0, 123]), false);
  expect(await first).toEqual(new Uint8Array([0, 123]));
  expect(request).toHaveBeenCalledTimes(1);
  const second = pipe.source.read(); expect(request).toHaveBeenLastCalledWith(false);
  pipe.accept(new Uint8Array([2, 3]), true); await second;
  expect(await pipe.source.read()).toBeNull();
  expect(request).toHaveBeenCalledTimes(2);expect(cancel).not.toHaveBeenCalled();
});

test("长度已满仍等待来源结束帧，空文件也须结束确认", async () => {
  const pipe = createTransferPipe("file", 1, vi.fn(), vi.fn());
  const first=pipe.source.read();pipe.accept(new Uint8Array([1]),false);await first;
  const end=pipe.source.read();pipe.accept(new Uint8Array(),true);expect(await end).toBeNull();
  const empty=createTransferPipe("empty",0,vi.fn(),vi.fn());
  const read=empty.source.read();empty.accept(new Uint8Array(),true);expect(await read).toBeNull();
});

test("短读和越界不提交，断线解除正在等待的读取", async () => {
  for (const chunk of [new Uint8Array(),new Uint8Array([1,2])]) {
    const cancel=vi.fn();const pipe=createTransferPipe("file",1,vi.fn(),cancel);
    const read=pipe.source.read();pipe.accept(chunk,true);
    await expect(read).rejects.toThrow("长度");expect(cancel).toHaveBeenCalledOnce();
  }
  const cancel=vi.fn();const pipe=createTransferPipe("file",513*1024*1024,vi.fn(),cancel);
  const read=pipe.source.read();pipe.source.abort(new Error("断线"));
  await expect(read).rejects.toThrow("断线");await expect(pipe.source.failed).rejects.toThrow("断线");
  expect(cancel).toHaveBeenCalledOnce();
});

test("流水窗口最多预取八块，消费后累计确认，结束后按序排空", async () => {
  const request = vi.fn(), cancel = vi.fn();
  const pipe = createTransferPipe("file", 10, request, cancel, 8);
  const first = pipe.source.read();
  expect(request).toHaveBeenLastCalledWith(true, 0);
  for (let i = 0; i < 8; i++) pipe.accept(new Uint8Array([i]), false);
  expect(await first).toEqual(new Uint8Array([0]));
  expect(request).toHaveBeenCalledTimes(1);
  expect(await pipe.source.read()).toEqual(new Uint8Array([1]));
  expect(request).toHaveBeenLastCalledWith(false, 1);
  pipe.accept(new Uint8Array([8]), false);
  expect(await pipe.source.read()).toEqual(new Uint8Array([2]));
  pipe.accept(new Uint8Array([9]), true);
  for (let i = 3; i < 10; i++) expect(await pipe.source.read()).toEqual(new Uint8Array([i]));
  expect(await pipe.source.read()).toBeNull(); expect(cancel).not.toHaveBeenCalled();
});

test("窗口溢出或超大分块立即取消并释放排队数据", async () => {
  for (const oversized of [false, true]) {
    const cancel = vi.fn(); const pipe = createTransferPipe("file", 10 * 262144, vi.fn(), cancel, 8);
    const first = pipe.source.read();
    if (oversized) pipe.accept(new Uint8Array(262145), false);
    else { for (let i = 0; i < 9; i++) pipe.accept(new Uint8Array([i]), false); }
    await first.catch(() => undefined);
    await expect(pipe.source.read()).rejects.toThrow("窗口"); expect(cancel).toHaveBeenCalledOnce();
  }
});
