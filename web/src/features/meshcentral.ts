export interface MeshCentralModule {
  protocol: number;
  parent?: AgentRedirect;
  xxStateChange(state: number): void;
  ProcessData?(data: string): void;
  ProcessBinaryData?(data: Uint8Array): void;
}

export interface MeshDesktopModule extends MeshCentralModule {
  ProcessBinaryCommand?(command: number, size: number, data: Uint8Array): void;
  remoteKeyMap: boolean;
  ImageType: number;
  CompressionLevel: number;
  ScalingLevel: number;
  FrameRateTimer: number;
  SendCompressionLevel(type: number, level: number, scaling: number, frameTimer: number): void;
  KeyAction: { NONE: number; DOWN: number; UP: number; SCROLL: number };
  SendKeyMsgKC(action: number, keyCode: number): void;
  SendStringUnicode(text: string): void;
  onScreenSizeChange: ((module: MeshDesktopModule, width: number, height: number, canvas: HTMLCanvasElement) => void) | null;
  SendMouseMsg(action: number, event: { pageX: number; pageY: number; wheelDelta?: number; button?: number; preventDefault?: () => void; stopPropagation?: () => void }): void;
  GrabMouseInput(): void;
  GrabKeyInput(): void;
  UnGrabMouseInput(): void;
  UnGrabKeyInput(): void;
}

export interface AgentRedirect<M extends MeshCentralModule = MeshCentralModule> {
  State: number;
  m: M;
  tunnelid: string;
  urlname: string;
  attemptWebRTC: boolean;
  onStateChanged: ((redirect: AgentRedirect<M>, state: number) => void) | null;
  onConsoleMessageChange: ((redirect: AgentRedirect<M>, message: string) => void) | null;
  Start(nodeId: string): void;
  Stop(): void;
  sendText(value: string | Record<string, unknown>): void;
  send(value: Uint8Array | string): void;
}

declare global {
  interface Window {
    urlargs: Record<string, string>;
    CreateAgentRemoteDesktop?: (canvas: HTMLCanvasElement) => MeshDesktopModule;
    CreateAgentRedirect?: <M extends MeshCentralModule>(
      meshServer: null,
      module: M,
      serverPublicNamePort: string,
      authCookie: string,
      relayAuthCookie: string,
      domainURL: string,
    ) => AgentRedirect<M>;
  }
}
