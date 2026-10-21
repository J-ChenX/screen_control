import { expect, it } from "vitest";
import type { NetworkResult } from "../../api/client";
import { networkPairs } from "./pairs";

const forward: NetworkResult = { source: "echova", target: "nix", path: "internet", ipVersion: 6, rttMs: 29.8, attempts: 5, responses: 5, initialRelay: false };
const reverse: NetworkResult = { ...forward, source: "nix", target: "echova", rttMs: 23.8 };

it("四台电脑只生成六组连接，并保留双向延迟范围", () => {
  const pairs = networkPairs([forward, reverse]);
  expect(pairs).toHaveLength(6);
  expect(new Set(pairs.map(pair => [pair.first.id, pair.second.id].sort().join("/"))).size).toBe(6);
  expect(pairs[0]).toMatchObject({ samePath: true, category: "direct", latency: "23.8–29.8 ms" });
});

it("双向协议或直连端点范围不同仍保留差异，不误算为两组连接", () => {
  expect(networkPairs([forward, { ...reverse, path: "lan", ipVersion: 4 }])[0]).toMatchObject({ samePath: false, category: "direct" });
  expect(networkPairs([forward, { ...reverse, ipVersion: 4 }])[0].samePath).toBe(false);
});

it("直连与中继不一致单独计数，单向成功或另一向超时不能算整组成功", () => {
  expect(networkPairs([forward, { ...reverse, path: "derp" }])[0].category).toBe("mixed");
  expect(networkPairs([forward])[0]).toMatchObject({ category: "unconfirmed", samePath: false, checked: false, latency: "29.8 ms（单向结果）" });
  expect(networkPairs([forward, { ...reverse, path: "timeout", rttMs: undefined }])[0].category).toBe("unconfirmed");
});

it("双向中继合并，尚有一向检测中时不报告整组完成", () => {
  expect(networkPairs([{ ...forward, path: "derp" }, { ...reverse, path: "derp" }])[0]).toMatchObject({ category: "relay", samePath: true });
  expect(networkPairs([forward, { ...reverse, path: "pending", rttMs: undefined }])[0]).toMatchObject({ category: "unconfirmed", checked: false });
});
