import { Fragment, useEffect, useRef, useState } from "react";
import { getNetworkTest, startNetworkTest, type NetworkPath, type NetworkResult, type NetworkTest } from "../../api/client";
import { type ClientDeviceId } from "../../app/model";
import { startVisiblePolling } from "../../network/visiblePolling";
import { networkPairs } from "./pairs";

export const networkLabels: Record<NetworkPath, string> = {
  pending: "检测中", lan: "局域网直连", internet: "互联网直连", "peer-relay": "私有中继", derp: "DERP 中继",
  timeout: "超时", offline: "离线", unavailable: "未验证",
};

function PathResult({ result, showLatency = true, compact = false }: { result: NetworkResult; showLatency?: boolean; compact?: boolean }) {
  const path = networkLabels[result.path] ? result.path : "unavailable";
  const direct = path === "lan" || path === "internet";
  const protocol = result.ipVersion === 4 || result.ipVersion === 6 ? `IPv${result.ipVersion}` : null;
  const label = direct ? `${path === "lan" ? "局域网" : "公网"}${protocol ? ` ${protocol}` : ""} 直连` : networkLabels[path];
  return <span className={`network-result network-${path}`}>
    <strong><span aria-hidden="true" />{label}</strong>
    {!compact && direct && !protocol && <small>IP 协议版本未确认，请重新测试</small>}
    {showLatency && result.rttMs !== undefined && <span className="network-rtt">{result.rttMs.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} ms</span>}
    {!compact && result.initialRelay && (path === "lan" || path === "internet") && <small>曾经中继</small>}
    {!compact && path === "unavailable" && <small>检查电脑网络或探针配置</small>}
    {!compact && path === "timeout" && <small>未收到响应</small>}
  </span>;
}

export function DirectTest({ localDeviceId }: { localDeviceId: ClientDeviceId | null }) {
  const [test, setTest] = useState<NetworkTest | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [expandedPair, setExpandedPair] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const submittingRef = useRef(false);
  const generation = useRef(0);
  const running = test?.state === "running";

  useEffect(() => {
    if (!localDeviceId) return;
    const abort = new AbortController();
    const current = generation.current;
    getNetworkTest(abort.signal).then(value => { if (!abort.signal.aborted && current === generation.current) setTest(value); }).catch(() => { /* 仅在主动检测失败后显示错误。 */ });
    return () => { abort.abort(); controller.current?.abort(); };
  }, [localDeviceId]);

  useEffect(() => {
    if (!running) return;
    return startVisiblePolling(async signal => {
      try { const value = await getNetworkTest(signal); if (!signal.aborted) { setTest(value); setError(""); } }
      catch (reason) { if (!signal.aborted) setError(reason instanceof Error ? reason.message : "无法读取检测结果，请稍后重新测试"); }
    }, 1000);
  }, [running]);

  async function start() {
    if (submittingRef.current || running) return;
    submittingRef.current = true;
    generation.current++;
    setSubmitting(true); setExpanded(true); setError("");
    const abort = new AbortController();
    controller.current = abort;
    try { setTest(await startNetworkTest(abort.signal)); }
    catch (reason) { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "检测未确认，请重新测试"); }
    finally { submittingRef.current = false; setSubmitting(false); }
  }

  const pairs = networkPairs(test?.results ?? []);
  const direct = pairs.filter(pair => pair.category === "direct").length;
  const relay = pairs.filter(pair => pair.category === "relay").length;
  const mixed = pairs.filter(pair => pair.category === "mixed").length;
  const checked = pairs.filter(pair => pair.checked).length;
  const stale = Boolean(test?.completedAt && Date.now() - Date.parse(test.completedAt) > 60_000);
  return <section className="network-test" aria-labelledby="network-test-title" aria-busy={running || submitting}>
    <div className="network-test-heading">
      <div><h2 id="network-test-title"><svg aria-hidden="true" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 6h5a5 5 0 0 1 5 5v5M5 8v6a4 4 0 0 0 4 4h8"/></svg>直连测试</h2>
        <p>检查各台电脑之间是否直连，以及当前往返延迟。</p></div>
      <div className="network-test-actions">
        {test && test.state !== "idle" && <button className="network-toggle" aria-expanded={expanded} aria-controls="network-test-results" onClick={() => setExpanded(!expanded)}>{expanded ? "收起结果" : "查看结果"}</button>}
        <button className="secondary-button network-start" onClick={() => { void start(); }} disabled={!localDeviceId || submitting || running}>{submitting || running ? "正在检测…" : test?.state === "complete" ? "重新测试" : "开始测试"}</button>
      </div>
    </div>
    <div className="network-summary" role="status" aria-live="polite">
      {running ? `正在检测 ${checked} / ${pairs.length} 组连接，通常需要 3～15 秒。` : test?.state === "complete" ? <><strong>{direct} 组直连</strong><span>{relay} 组中继</span>{mixed > 0 && <span>{mixed} 组直连与中继不一致</span>}<span>{pairs.length - direct - relay - mixed} 组未确认</span><span>{stale ? "结果可能已过期，请重新测试" : `检测于 ${new Date(test.completedAt!).toLocaleTimeString("zh-CN", { hour12: false })}`}</span></> : "点击开始测试，检查全部登记电脑；测试不会自动重复运行。"}
    </div>
    {error && <p className="network-error" role="alert">{error}。已有结果仅供参考。</p>}
    {expanded && test && test.state !== "idle" && <div id="network-test-results" className="network-test-results">
      <p className="network-scope">仅检测 Tailscale 路径；延迟为双向测量范围。箭头表示检测方向，详情可展开。</p>
      <table className="network-pairs"><caption className="visually-hidden">每两台电脑一组连接，保留双向检测结果；不代表网页控屏或文件已端到端直传</caption><thead><tr><th scope="col">设备连接</th><th scope="col">连接状态</th><th scope="col">往返延迟</th><th scope="col"><span className="visually-hidden">详情</span></th></tr></thead><tbody>{pairs.map(pair => { const key = `${pair.first.id}/${pair.second.id}`, detailId = `network-detail-${pair.first.id}-${pair.second.id}`, showDetail = expandedPair === key; return <Fragment key={key}><tr className="network-pair-row">
        <th scope="row"><span className="network-pair-devices">{[pair.first, pair.second].map((device, index) => <span key={device.id}>{index > 0 && <span className="network-pair-arrow" aria-label="与">↔</span>}{device.name}{device.id === localDeviceId && <small>当前设备</small>}</span>)}</span></th>
        <td className="network-pair-state">
          {pair.samePath ? <PathResult result={pair.forward} showLatency={false} compact /> : <div className="network-paths">{[pair.forward, pair.reverse].map((result, index) => <span className="network-directed-path" key={result.source} aria-label={`${result.source} 到 ${result.target}`}><span aria-hidden="true">{index === 0 ? "→" : "←"}</span><PathResult result={result} showLatency={false} compact /></span>)}</div>}
        </td>
        <td className="network-pair-latency"><span className="network-mobile-label">往返延迟</span><span className="network-rtt">{pair.latency}</span></td>
        <td className="network-pair-action"><button className="network-detail-toggle" aria-label={`${pair.first.name} 与 ${pair.second.name}的双向检测详情`} aria-expanded={showDetail} aria-controls={detailId} onClick={() => setExpandedPair(showDetail ? null : key)}>{showDetail ? "收起" : "详情"}</button></td>
      </tr>{showDetail && <tr className="network-detail-row" id={detailId}><td colSpan={4}><div className="network-directions">{[pair.forward, pair.reverse].map(result => <div className="network-direction" key={result.source}><span>{result.source} → {result.target}</span><PathResult result={result} /></div>)}</div></td></tr>}</Fragment>; })}</tbody></table>
    </div>}
  </section>;
}
