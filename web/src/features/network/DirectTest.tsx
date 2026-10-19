import { useEffect, useRef, useState } from "react";
import { getNetworkTest, startNetworkTest, type NetworkPath, type NetworkResult, type NetworkTest } from "../../api/client";
import { registeredDevices, type ClientDeviceId } from "../../app/model";
import { startVisiblePolling } from "../../network/visiblePolling";

export const networkLabels: Record<NetworkPath, string> = {
  pending: "检测中", lan: "局域网直连", internet: "互联网直连", "peer-relay": "私有中继", derp: "DERP 中继",
  timeout: "超时", offline: "离线", unavailable: "未验证",
};

function PathResult({ result }: { result?: NetworkResult }) {
  if (!result) return <span className="network-self" aria-label="同一设备无需检测">—</span>;
  const path = networkLabels[result.path] ? result.path : "unavailable";
  const direct = path === "lan" || path === "internet";
  const protocol = result.ipVersion === 4 || result.ipVersion === 6 ? `IPv${result.ipVersion}` : null;
  const label = direct ? `${path === "lan" ? "局域网" : "公网"}${protocol ? ` ${protocol}` : ""} 直连` : networkLabels[path];
  return <div className={`network-result network-${path}`}>
    <strong><span aria-hidden="true" />{label}</strong>
    {direct && !protocol && <small>IP 协议版本未确认，请重新测试</small>}
    {result.rttMs !== undefined && <span className="network-rtt">{result.rttMs.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} ms</span>}
    {result.initialRelay && (path === "lan" || path === "internet") && <small>曾经中继</small>}
    {path === "unavailable" && <small>检查电脑网络或探针配置</small>}
    {path === "timeout" && <small>未收到响应</small>}
  </div>;
}

export function DirectTest({ localDeviceId }: { localDeviceId: ClientDeviceId | null }) {
  const [test, setTest] = useState<NetworkTest | null>(null);
  const [expanded, setExpanded] = useState(false);
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

  const direct = test?.results.filter(row => row.path === "lan" || row.path === "internet").length ?? 0;
  const relay = test?.results.filter(row => row.path === "derp" || row.path === "peer-relay").length ?? 0;
  const checked = test?.results.filter(row => row.path !== "pending").length ?? 0;
  const stale = Boolean(test?.completedAt && Date.now() - Date.parse(test.completedAt) > 60_000);
  const find = (source: string, target: string) => test?.results.find(row => row.source === source && row.target === target);
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
      {running ? `正在检测 ${checked} / ${test.results.length} 个方向，通常需要 3～15 秒。` : test?.state === "complete" ? <><strong>{direct} 个方向直连</strong><span>{relay} 个中继</span><span>{test.results.length - direct - relay} 个未确认</span><span>{stale ? "结果可能已过期，请重新测试" : `检测于 ${new Date(test.completedAt!).toLocaleTimeString("zh-CN", { hour12: false })}`}</span></> : "点击开始测试，检查全部登记电脑；测试不会自动重复运行。"}
    </div>
    {error && <p className="network-error" role="alert">{error}。已有结果仅供参考。</p>}
    {expanded && test && test.state !== "idle" && <div id="network-test-results" className="network-test-results">
      <p className="network-scope">检测 Tailscale 底层路径，不代表网页控屏或文件已端到端直传。每个方向独立检测，网络变化后请重新测试。</p>
      <table className="network-matrix"><caption className="visually-hidden">行是发起电脑，列是目标电脑</caption><thead><tr><th scope="col">发起端 ↓ / 目标 →</th>{registeredDevices.map(device => <th scope="col" key={device.id}>{device.name}</th>)}</tr></thead><tbody>{registeredDevices.map(source => <tr key={source.id}><th scope="row">{source.name}{source.id === localDeviceId && <small>当前设备</small>}</th>{registeredDevices.map(target => <td key={target.id}><PathResult result={source.id === target.id ? undefined : find(source.id, target.id) ?? { source: source.id, target: target.id, path: "unavailable", attempts: 0, responses: 0, initialRelay: false }} /></td>)}</tr>)}</tbody></table>
      <div className="network-mobile-results">{registeredDevices.map(source => <section className="network-source" key={source.id} aria-label={`${source.name} 发起的检测`}><h3>{source.name} <span>发起{source.id === localDeviceId ? " · 当前设备" : ""}</span></h3>{registeredDevices.filter(target => target.id !== source.id).map(target => <div className="network-mobile-row" key={target.id}><span>→ {target.name}</span><PathResult result={find(source.id, target.id) ?? { source: source.id, target: target.id, path: "unavailable", attempts: 0, responses: 0, initialRelay: false }} /></div>)}</section>)}</div>
    </div>}
  </section>;
}
