import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ConnectionRecovery } from "../../network/recovery";
import { normalizeCursorCommand } from "./cursor";
import { installTouchInput } from "./touch";
import { createDesktopSession, endDesktopSession, lockExitDesktopSession } from "../../api/client";
import type { Device } from "../../app/model";
import type { AgentRedirect, MeshDesktopModule } from "../meshcentral";

type SessionState = "idle" | "starting" | "relay" | "connected" | "ended" | "error";

const labels: Record<SessionState, string> = {
  idle: "等待连接",
  starting: "正在创建安全会话",
  relay: "正在连接实机中继",
  connected: "实机桌面已连接",
  ended: "会话已结束",
  error: "连接失败",
};

export function fitRemoteCanvas(screenWidth: number, screenHeight: number, viewportWidth: number, viewportHeight: number) {
  if (screenWidth <= 0 || screenHeight <= 0 || viewportWidth <= 0 || viewportHeight <= 0) return { width: 0, height: 0 };
  const scale = Math.min(viewportWidth / screenWidth, viewportHeight / screenHeight);
  return { width: Math.round(screenWidth * scale), height: Math.round(screenHeight * scale) };
}

export function MeshDesktop({ device, toolbarTarget, inputSuspended = false }: { device: Device; toolbarTarget: HTMLElement | null; inputSuspended?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const redirectRef = useRef<AgentRedirect<MeshDesktopModule> | null>(null);
  const inputSuspendedRef = useRef(inputSuspended);
  inputSuspendedRef.current = inputSuspended;
  useEffect(() => {
    const module = redirectRef.current?.m;
    if (!module) return;
    if (inputSuspended) { module.UnGrabKeyInput(); module.UnGrabMouseInput(); }
    else if (state === "connected") { module.GrabKeyInput(); module.GrabMouseInput(); }
  }, [inputSuspended]);
  const sessionRef = useRef<string | null>(null);
  const wheelCleanupRef = useRef<(() => void) | null>(null);
  const touchCleanupRef = useRef<(() => void) | null>(null);
  const rightClickRef = useRef(false);
  const [rightClick, setRightClick] = useState(false);
  const [smooth, setSmooth] = useState(false);
  const smoothRef = useRef(false);
  const [inputText, setInputText] = useState("");
  const mountedRef = useRef(true);
  const autoStartAttemptedRef = useRef(false);
  const [state, setState] = useState<SessionState>("idle");
  const [ending, setEnding] = useState(false);
  const endingRef = useRef(false);
  const [lockNotice, setLockNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const handshakeTimer = useRef<number | undefined>(undefined);
  const startRef = useRef<() => void>(() => undefined);
  const recovery = useRef<ConnectionRecovery | null>(null);
  if (!recovery.current) recovery.current = new ConnectionRecovery(() => startRef.current());

  const fitCanvas = () => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport) return;
    const fitted = fitRemoteCanvas(canvas.width, canvas.height, viewport.clientWidth, viewport.clientHeight);
    if (fitted.width === 0 || fitted.height === 0) return;
    canvas.style.width = `${fitted.width}px`;
    canvas.style.height = `${fitted.height}px`;
  };

  const installWheelInput = (module: MeshDesktopModule) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    wheelCleanupRef.current?.();
    (canvas as HTMLCanvasElement & { onmousewheel: ((event: Event) => unknown) | null }).onmousewheel = null;
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      event.stopPropagation();
      module.SendMouseMsg(module.KeyAction.SCROLL, {
        pageX: event.pageX,
        pageY: event.pageY,
        wheelDelta: -Math.sign(event.deltaY) * 40,
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
      });
    };
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    wheelCleanupRef.current = () => canvas.removeEventListener("wheel", handleWheel);
  };

  const stop = async (nextState: SessionState = "ended", recover = false) => {
    generation.current++;
    window.clearTimeout(handshakeTimer.current);
    busy.current = false;
    if (!recover) recovery.current!.stop();
    const sessionId = sessionRef.current;
    sessionRef.current = null;
    const redirect = redirectRef.current;
    redirectRef.current = null;
    wheelCleanupRef.current?.();
    wheelCleanupRef.current = null;
    touchCleanupRef.current?.();
    touchCleanupRef.current = null;
    if (redirect) {
      redirect.m.UnGrabKeyInput();
      redirect.m.UnGrabMouseInput();
      redirect.Stop();
    }
    if (mountedRef.current) setState(nextState);
    if (recover) recovery.current!.failed();
    if (sessionId) {
      try { await endDesktopSession(sessionId); } catch { /* 中继关闭时会话已失效。 */ }
    }
  };

  const lockAndStop = async () => {
    if (endingRef.current) return;
    const sessionId = sessionRef.current;
    if (state !== "connected" || !sessionId) { await stop(); return; }
    endingRef.current = true;
    setEnding(true);
    setError(null);
    recovery.current!.stop();
    // 锁屏期间禁止重连，保留中继直到服务端发出锁屏指令。
    generation.current++;
    redirectRef.current?.m.UnGrabKeyInput();
    redirectRef.current?.m.UnGrabMouseInput();
    let notice = "锁屏请求已发送，连接已结束；暂无法确认目标是否已锁屏。";
    try {
      await lockExitDesktopSession(sessionId);
    } catch (caught) {
      notice = `${caught instanceof Error ? caught.message : "锁屏请求失败"}。连接已结束，锁屏结果未知，请检查目标电脑。`;
    } finally {
      await stop();
      endingRef.current = false;
      if (mountedRef.current) { setEnding(false); setLockNotice(notice); }
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    const online = () => { if (!busy.current && !redirectRef.current) recovery.current!.online(); };
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("online", online);
      mountedRef.current = false;
      void stop("ended");
    };
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(fitCanvas);
    observer.observe(viewport);
    fitCanvas();
    return () => observer.disconnect();
  }, []);

  const start = async () => {
    if (!canvasRef.current || busy.current || redirectRef.current || endingRef.current) return;
    recovery.current!.enable();
    if (!navigator.onLine) { setState("error"); setError("网络已断开，恢复后将自动连接。"); recovery.current!.failed(); return; }
    busy.current = true;
    const attempt = ++generation.current;
    window.clearTimeout(handshakeTimer.current);
    handshakeTimer.current = window.setTimeout(() => {
      if (generation.current !== attempt) return;
      setError("连接超时，正在自动重试。");
      void stop("error", true);
    }, 20_000);
    setError(null);
    setLockNotice(null);
    setState("starting");
    try {
      if (!window.CreateAgentRemoteDesktop || !window.CreateAgentRedirect) {
        throw new Error("桌面协议组件未加载，请刷新页面后重试");
      }
      const session = await createDesktopSession(device.id);
      if (!mountedRef.current || attempt !== generation.current) {
        await endDesktopSession(session.desktopSessionId);
        return;
      }
      sessionRef.current = session.desktopSessionId;
      const module = window.CreateAgentRemoteDesktop(canvasRef.current);
      const processCommand = module.ProcessBinaryCommand?.bind(module);
      if (processCommand) module.ProcessBinaryCommand = (command, size, data) => processCommand(command, size, normalizeCursorCommand(command, size, data));
      // Windows 输入法需要字母按键事件来生成预编辑文本和候选项。
      // MeshCentral 默认的 Unicode 数据包会直接插入已完成的文本。
      module.remoteKeyMap = device.platform === "Windows";
      module.ImageType = 1;
      module.CompressionLevel = smoothRef.current ? 45 : 60;
      module.ScalingLevel = smoothRef.current ? 512 : 1024;
      // 40 毫秒允许每秒最多约 25 次采集；实际更新速度取决于代理和链路。
      module.FrameRateTimer = 40;
      module.onScreenSizeChange = (_desktop, width, height, canvas) => {
        // 重复设置相同尺寸也会清空画布并重置绘图状态。
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        window.requestAnimationFrame(fitCanvas);
      };

      const redirect = window.CreateAgentRedirect(null, module, window.location.host, "", "", "/");
      redirect.tunnelid = session.tunnelId;
      redirect.urlname = `../../../${session.relayPath.replace(/^\//, "")}`;
      redirect.attemptWebRTC = false;
      redirect.onStateChanged = (activeRedirect, relayState) => {
        if (!mountedRef.current || attempt !== generation.current) return;
        if (relayState === 2) setState("relay");
        if (relayState === 3) {
          window.clearTimeout(handshakeTimer.current);
          busy.current = false;
          recovery.current!.connected();
          if (!inputSuspendedRef.current) {
            activeRedirect.m.GrabMouseInput();
            activeRedirect.m.GrabKeyInput();
          }
          installWheelInput(activeRedirect.m);
          touchCleanupRef.current?.();
          touchCleanupRef.current = installTouchInput(canvasRef.current!, activeRedirect.m, () => rightClickRef.current);
          setState("connected");
        }
        if (relayState === 0 && sessionRef.current) {
          setError("连接中断，正在自动重连。旧的键鼠操作不会重放。");
          void stop("ended", true);
        }
      };
      redirect.onConsoleMessageChange = (_redirect, message) => {
        if (!message || !mountedRef.current || attempt !== generation.current) return;
        setError(message);
      };
      redirectRef.current = redirect;
      setState("relay");
      redirect.Start(session.nodeId);
    } catch (caught) {
      if (attempt !== generation.current) return;
      void stop("error", true);
      if (mountedRef.current) {
        setError(caught instanceof Error ? caught.message : "无法建立远程桌面连接");
        setState("error");
      }
    }
  };

  startRef.current = () => { void start(); };

  useEffect(() => {
    if (device.state !== "online" || state !== "idle" || autoStartAttemptedRef.current) return;
    const timer = window.setTimeout(() => {
      autoStartAttemptedRef.current = true;
      void start();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [device.state, state]);

  const active = state === "starting" || state === "relay" || state === "connected";

  return (
    <div className={`mesh-desktop mesh-desktop-${state}`}>
      <div className="mesh-canvas-wrap" ref={viewportRef}>
        <canvas
          ref={canvasRef}
          width={960}
          height={701}
          tabIndex={0}
          aria-label={`${device.name} 实机远程桌面`}
          onContextMenu={(event) => {
            // MeshCentral 负责转发鼠标按键事件；这里只屏蔽本地浏览器菜单。
            event.preventDefault();
            event.stopPropagation();
          }}
        />
        {!active && (
          <div className="mesh-desktop-empty">
            <span className="mesh-screen-symbol" aria-hidden="true" />
            <h2>{state === "ended" ? "桌面会话已结束" : state === "error" ? "连接未成功" : device.state === "online" ? "正在准备桌面" : "设备当前离线"}</h2>
            <p>画面和输入通过当前入口的安全中继传输，页面不会获得 MeshCentral 密码或授权令牌。</p>
            {(state === "ended" || state === "error") && <button onClick={() => void start()} disabled={device.state !== "online"}>{device.state === "online" ? "重新连接" : "设备当前离线"}</button>}
          </div>
        )}
        {active && state !== "connected" && <div className="mesh-connecting"><span /><strong>{labels[state]}</strong></div>}
      </div>
      {toolbarTarget && createPortal(<>
        <span className="desktop-session-status" role="status" aria-label={labels[state]} title={labels[state]}>
          <span aria-hidden="true" className={state === "connected" ? "live-dot" : "session-state-dot"} />
          <span className="desktop-session-label">{labels[state]}</span>
        </span>
        <button aria-pressed={smooth} title="流畅模式降低画质并将传输宽高减半，适合带宽不足时使用" disabled={state !== "connected"} onClick={() => {
          const next = !smoothRef.current;
          redirectRef.current?.m.SendCompressionLevel(1, next ? 45 : 60, next ? 512 : 1024, 40);
          smoothRef.current = next;
          setSmooth(next);
        }}>{smooth ? "流畅：开" : "流畅：关"}</button>
        <button onClick={() => void lockAndStop()} disabled={ending || (!active && !recovery.current!.enabled)} title="锁定被控电脑并结束连接；直接返回不会锁屏">{ending ? "正在结束…" : state === "connected" ? "锁屏并结束连接" : "结束连接"}</button>
      </>, toolbarTarget)}
      <div className="mobile-input-toolbar" aria-label="触屏控制" hidden={state !== "connected"}>
        <span>轻触点击，按住拖动</span>
        <button aria-pressed={rightClick} onClick={() => { rightClickRef.current = !rightClick; setRightClick(!rightClick); }}>右键{rightClick ? "：开" : "：关"}</button>
        {[[-40, "向下滚动"], [40, "向上滚动"]].map(([delta, label]) => <button key={label} onClick={() => {
          const rect = canvasRef.current!.getBoundingClientRect();
          const module = redirectRef.current?.m;
          module?.SendMouseMsg(module.KeyAction.SCROLL, { pageX: rect.left + rect.width / 2 + window.scrollX, pageY: rect.top + rect.height / 2 + window.scrollY, wheelDelta: Number(delta) });
        }}>{label}</button>)}
        {[[13, "回车"], [8, "退格"], [27, "Esc"], [9, "Tab"]].map(([code, label]) => <button key={label} onClick={() => {
          const module = redirectRef.current?.m;
          module?.SendKeyMsgKC(module.KeyAction.DOWN, Number(code));
          module?.SendKeyMsgKC(module.KeyAction.UP, Number(code));
        }}>{label}</button>)}
        <input aria-label="远程输入文字" placeholder="输入文字后发送" value={inputText} onChange={(event) => setInputText(event.target.value)} onFocus={() => redirectRef.current?.m.UnGrabKeyInput()} onBlur={() => { if (state === "connected") redirectRef.current?.m.GrabKeyInput(); }} />
        <button disabled={!inputText} onClick={() => { redirectRef.current?.m.SendStringUnicode(inputText); setInputText(""); }}>发送文字</button>
      </div>
      {lockNotice && <div className="mesh-error" role="status">{lockNotice}</div>}
      {error && <div className="mesh-error" role="alert">{error}</div>}
    </div>
  );
}
