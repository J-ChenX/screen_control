import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionRecovery } from "./recovery";
afterEach(() => vi.useRealTimers());
describe("connection recovery", () => {
 it("backs off, avoids duplicate retries and resets on success", () => {
  vi.useFakeTimers(); const retry=vi.fn(); const r=new ConnectionRecovery(retry); r.enable();
  r.failed(); r.failed(); vi.advanceTimersByTime(1000); expect(retry).toHaveBeenCalledTimes(1);
  r.failed(); vi.advanceTimersByTime(1000); expect(retry).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1000); expect(retry).toHaveBeenCalledTimes(2);
  r.connected();vi.advanceTimersByTime(30000);r.failed();vi.advanceTimersByTime(1000);expect(retry).toHaveBeenCalledTimes(3);
 });
 it("keeps backoff across short-lived connections", () => {
  vi.useFakeTimers(); const retry=vi.fn(); const r=new ConnectionRecovery(retry); r.enable();
  r.failed(); vi.advanceTimersByTime(1000); expect(retry).toHaveBeenCalledTimes(1);
  r.connected(); vi.advanceTimersByTime(5000); r.failed();
  vi.advanceTimersByTime(1000); expect(retry).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1000); expect(retry).toHaveBeenCalledTimes(2);
  r.connected(); vi.advanceTimersByTime(5000); r.failed();
  vi.advanceTimersByTime(3999); expect(retry).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(1); expect(retry).toHaveBeenCalledTimes(3);
  r.stop(); expect(vi.getTimerCount()).toBe(0);
 });
 it("cancels pending retry when a new attempt starts", () => {
  vi.useFakeTimers(); const retry=vi.fn(); const r=new ConnectionRecovery(retry); r.enable();
  r.failed(); r.enable(); vi.advanceTimersByTime(1000);
  expect(retry).not.toHaveBeenCalled();
  r.connected(); r.stop(); expect(vi.getTimerCount()).toBe(0);
 });
 it("never reconnects after manual stop or unmount", () => {
  vi.useFakeTimers(); const retry=vi.fn(); const r=new ConnectionRecovery(retry);r.enable();r.failed();r.stop();r.online();r.failed();
  vi.advanceTimersByTime(60000);expect(retry).not.toHaveBeenCalled();
 });
 it("accelerates pending recovery when the network returns",()=>{
  vi.useFakeTimers();const retry=vi.fn();const r=new ConnectionRecovery(retry);r.enable();
  for(let i=0;i<6;i++){r.failed();vi.advanceTimersByTime(30000)}
  r.failed();r.online();vi.advanceTimersByTime(1000);expect(retry).toHaveBeenCalledTimes(7);
 });
});
