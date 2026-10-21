import type { NetworkResult } from "../../api/client";
import { registeredDevices } from "../../app/model";

const isDirect = (result: NetworkResult) => result.path === "lan" || result.path === "internet";
const isRelay = (result: NetworkResult) => result.path === "derp" || result.path === "peer-relay";

// 双向都取得结果后才计为一组已确认连接，不能用单向成功掩盖另一向失败。
export function networkPairs(results: NetworkResult[]) {
  return registeredDevices.flatMap((first, index) => registeredDevices.slice(index + 1).map(second => {
    const find = (source: typeof first, target: typeof second): NetworkResult => results.find(row => row.source === source.id && row.target === target.id)
      ?? { source: source.id, target: target.id, path: "unavailable", attempts: 0, responses: 0, initialRelay: false };
    const forward = find(first, second), reverse = find(second, first);
    const samePath = forward.path === reverse.path && (!isDirect(forward) || forward.ipVersion === reverse.ipVersion);
    const category = isDirect(forward) && isDirect(reverse) ? "direct"
      : isRelay(forward) && isRelay(reverse) ? "relay"
      : (isDirect(forward) || isRelay(forward)) && (isDirect(reverse) || isRelay(reverse)) ? "mixed" : "unconfirmed";
    const checked = results.some(row => row.source === first.id && row.target === second.id)
      && results.some(row => row.source === second.id && row.target === first.id)
      && forward.path !== "pending" && reverse.path !== "pending";
    const rtts = [forward.rttMs, reverse.rttMs].filter((value): value is number => value !== undefined);
    const format = (value: number) => value.toLocaleString("zh-CN", { maximumFractionDigits: 1 });
    const low = Math.min(...rtts), high = Math.max(...rtts);
    const latency = rtts.length === 0 ? "—" : rtts.length === 1 ? `${format(low)} ms（单向结果）`
      : format(low) === format(high) ? `${format(low)} ms` : `${format(low)}–${format(high)} ms`;
    return { first, second, forward, reverse, samePath, category, checked, latency };
  }));
}
