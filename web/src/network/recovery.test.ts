import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionRecovery } from "./recovery";
afterEach(() => vi.useRealTimers());
describe("connection recovery", () => {
 it("backs off, avoids duplicate retries and resets on success", () => {
  vi.useFakeTimers(); const retry=vi.fn(); const r=new ConnectionRecovery(retry); r.enable();
  r.failed(); r.failed(); vi.advanceTimersByTime(1000); expect(retry).toHaveBeenCalledTimes(1);
  r.failed(); vi.advanceTimersByTime(1000); expect(retry).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1000); expect(retry).toHaveBeenCalledTimes(2);
  r.connected();r.failed();vi.advanceTimersByTime(1000);expect(retry).toHaveBeenCalledTimes(3);
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
