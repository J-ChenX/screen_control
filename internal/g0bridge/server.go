package g0bridge

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	appidentity "screencontrol.local/screen-control/internal/identity"

	"github.com/coder/websocket"
)

type Server struct {
	favorites      *FavoriteStore
	fileOpen       fileOpener
	mesh           MeshClient
	logger         *slog.Logger
	sessions       sync.Map
	sessionSlots   chan struct{}
	allowedOrigins map[string]struct{}
	originPatterns []string
	assetCache     sync.Map
	identity       appidentity.Resolver
}

type desktopSession struct {
	files         fileChannel
	closed        bool
	stopExpiry    func() bool
	stopPending   *time.Timer
	releaseSlot   func()
	tunnel        *Tunnel
	created       time.Time
	owner         string
	cancel        context.CancelFunc
	mu            sync.Mutex
	relayClaimed  atomic.Bool
	upstream      *websocket.Conn
	lockRequested bool
}

type envelope struct {
	APIVersion string `json:"apiVersion"`
	RequestID  string `json:"requestId"`
	Data       any    `json:"data,omitempty"`
	Error      any    `json:"error,omitempty"`
}

func NewServer(mesh MeshClient, logger *slog.Logger, origins ...string) *Server {
	return NewServerWithIdentity(mesh, nil, logger, origins...)
}

// NewServerWithIdentity 创建桥接服务，其会话 API 通过可信的套接字身份
// 解析器确定调用方设备。
func NewServerWithIdentity(mesh MeshClient, identityResolver appidentity.Resolver, logger *slog.Logger, origins ...string) *Server {
	if logger == nil {
		logger = slog.Default()
	}
	if len(origins) == 0 {
		origins = []string{"http://127.0.0.1:5173", "http://localhost:5173"}
	}
	server := &Server{sessionSlots: make(chan struct{}, 16), mesh: mesh, logger: logger, identity: identityResolver, allowedOrigins: make(map[string]struct{})}
	for _, origin := range origins {
		origin = strings.TrimRight(strings.TrimSpace(origin), "/")
		parsed, err := url.Parse(origin)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" {
			continue
		}
		server.allowedOrigins[origin] = struct{}{}
		server.originPatterns = append(server.originPatterns, parsed.Host)
	}
	return server
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/files/favorites/{deviceID}", s.handleFavorites)
	mux.HandleFunc("POST /api/v1/files/favorites/{deviceID}", s.handleFavorites)
	mux.HandleFunc("GET /api/v1/identity/device", s.handleDeviceIdentity)
	mux.HandleFunc("GET /api/v1/control/snapshot", s.handleSnapshot)
	mux.HandleFunc("POST /api/v1/desktops", s.handleCreateDesktop)
	mux.HandleFunc("GET /api/v1/desktops/{sessionID}/relay", s.handleRelay)
	mux.HandleFunc("POST /api/v1/desktops/{sessionID}/end", s.handleEndDesktop)
	mux.HandleFunc("POST /api/v1/desktops/{sessionID}/lock-exit", s.handleLockExit)
	mux.HandleFunc("POST /api/v1/files/sessions", s.handleCreateFileSession)
	mux.HandleFunc("GET /api/v1/files/sessions/{sessionID}/relay", s.handleRelay)
	mux.HandleFunc("POST /api/v1/files/sessions/{sessionID}/end", s.handleEndFileSession)
	mux.HandleFunc("GET /api/v1/vendor/{asset}", s.handleVendorAsset)
	mux.HandleFunc("GET /api/v1/health", func(w http.ResponseWriter, r *http.Request) {
		s.writeJSON(w, http.StatusOK, requestID(), map[string]any{"status": "ok", "mode": "g0-live"}, nil)
	})
	return s.withHeaders(mux)
}

func (s *Server) withHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		stripUntrustedIdentityHeaders(r.Header)
		if r.Method != http.MethodGet && !s.allowedOrigin(r.Header.Get("Origin")) {
			s.writeError(w, http.StatusForbidden, requestID(), "ORIGIN_NOT_ALLOWED", "请求来源不受信任")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func stripUntrustedIdentityHeaders(header http.Header) {
	for name := range header {
		canonical := http.CanonicalHeaderKey(name)
		if canonical == "Forwarded" || strings.HasPrefix(canonical, "X-Forwarded-") ||
			strings.HasPrefix(canonical, "X-Screen-Control-") || strings.HasPrefix(canonical, "Tailscale-") {
			header.Del(name)
		}
	}
}

func (s *Server) allowedOrigin(origin string) bool {
	if origin == "" {
		return false
	}
	_, ok := s.allowedOrigins[strings.TrimRight(origin, "/")]
	return ok
}

func requestID() string { return "req_" + randomHex(8) }
func randomHex(size int) string {
	buffer := make([]byte, size)
	if _, err := rand.Read(buffer); err != nil {
		panic(fmt.Sprintf("secure randomness unavailable: %v", err))
	}
	return hex.EncodeToString(buffer)
}

func (s *Server) writeJSON(w http.ResponseWriter, status int, reqID string, data, apiError any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(envelope{APIVersion: "v1", RequestID: reqID, Data: data, Error: apiError})
}

func (s *Server) writeError(w http.ResponseWriter, status int, reqID, code, message string) {
	s.writeJSON(w, status, reqID, nil, map[string]string{"code": code, "message": message})
}

func (s *Server) resolveDevice(w http.ResponseWriter, r *http.Request, reqID string) (string, bool) {
	if s.identity == nil {
		s.writeError(w, http.StatusServiceUnavailable, reqID, "DEVICE_IDENTITY_UNAVAILABLE", "无法验证当前设备，请从受信的 Tailscale 入口访问")
		return "", false
	}
	localAddr, _ := r.Context().Value(http.LocalAddrContextKey).(net.Addr)
	deviceID, err := s.identity.Resolve(r.Context(), remoteAddress(r), localAddr)
	if err != nil {
		if errors.Is(err, appidentity.ErrUnregistered) {
			s.writeError(w, http.StatusForbidden, reqID, "DEVICE_NOT_REGISTERED", "当前 Tailscale 设备尚未登记")
			return "", false
		}
		s.logger.Warn("device identity resolution failed", "requestId", reqID, "error", err)
		s.writeError(w, http.StatusServiceUnavailable, reqID, "DEVICE_IDENTITY_UNAVAILABLE", "无法验证当前设备，请确认 Tailscale 连接后重试")
		return "", false
	}
	if !registeredDeviceID(deviceID) {
		s.writeError(w, http.StatusForbidden, reqID, "DEVICE_NOT_REGISTERED", "当前 Tailscale 设备尚未登记")
		return "", false
	}
	return deviceID, true
}

func remoteAddress(r *http.Request) net.Addr {
	address, err := net.ResolveTCPAddr("tcp", r.RemoteAddr)
	if err != nil {
		return stringAddr(r.RemoteAddr)
	}
	return address
}

type stringAddr string

func (a stringAddr) Network() string { return "unknown" }
func (a stringAddr) String() string  { return string(a) }

func (s *Server) handleDeviceIdentity(w http.ResponseWriter, r *http.Request) {
	reqID := requestID()
	deviceID, ok := s.resolveDevice(w, r, reqID)
	if !ok {
		return
	}
	mode := "tailscale"
	if _, ok := appidentity.AuthenticatedPrincipal(r.Context()); ok {
		mode = "gateway"
	}
	s.writeJSON(w, http.StatusOK, reqID, map[string]string{"deviceId": deviceID, "accessMode": mode}, nil)
}

func (s *Server) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	reqID := requestID()
	devices, err := s.mesh.Snapshot(r.Context())
	if err != nil {
		s.logger.Warn("device snapshot failed", "requestId", reqID, "error", err)
		s.writeError(w, http.StatusBadGateway, reqID, "UPSTREAM_UNAVAILABLE", "无法读取实机状态")
		return
	}
	s.writeJSON(w, http.StatusOK, reqID, map[string]any{
		"mode": "g0-live", "generatedAt": time.Now().UTC().Format(time.RFC3339), "devices": devices,
	}, nil)
}

type createDesktopRequest struct {
	TargetDeviceID string `json:"targetDeviceId"`
}

func (s *Server) handleCreateDesktop(w http.ResponseWriter, r *http.Request) {
	s.handleCreateSession(w, r, 2, "desktop")
}

func (s *Server) handleCreateFileSession(w http.ResponseWriter, r *http.Request) {
	s.handleCreateSession(w, r, 5, "files")
}

func (s *Server) handleCreateSession(w http.ResponseWriter, r *http.Request, protocol int, kind string) {
	reqID := requestID()
	clientDeviceID, ok := s.resolveDevice(w, r, reqID)
	if !ok {
		return
	}
	var input createDesktopRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		message := "桌面会话请求无效"
		if kind == "files" {
			message = "文件会话请求无效"
		}
		s.writeError(w, http.StatusBadRequest, reqID, "INVALID_REQUEST", message)
		return
	}
	if protocol == 2 && input.TargetDeviceID == clientDeviceID {
		s.writeError(w, http.StatusConflict, reqID, "SELF_TARGET_NOT_ALLOWED", "不能控制当前设备")
		return
	}
	if !remoteTargetDeviceID(input.TargetDeviceID) {
		s.writeError(w, http.StatusForbidden, reqID, "TARGET_NOT_SUPPORTED", "该设备不提供远程桌面或文件代理；手机请通过浏览器上传和下载文件")
		return
	}
	// 建连中的请求也占用配额，防止并发请求绕过存量会话上限。
	select {
	case s.sessionSlots <- struct{}{}:
	default:
		s.writeError(w, http.StatusServiceUnavailable, reqID, "SESSION_CAPACITY_EXCEEDED", "会话数量已达上限，请结束不用的连接后重试")
		return
	}
	releaseSlot := sync.OnceFunc(func() { <-s.sessionSlots })
	retained := false
	defer func() {
		if !retained {
			releaseSlot()
		}
	}()
	devices, err := s.mesh.Devices(r.Context())
	if err != nil {
		s.writeError(w, http.StatusBadGateway, reqID, "UPSTREAM_UNAVAILABLE", "无法确认目标设备状态")
		return
	}
	var target *Device
	for index := range devices {
		if devices[index].ID == input.TargetDeviceID {
			target = &devices[index]
			break
		}
	}
	if target == nil {
		s.writeError(w, http.StatusNotFound, reqID, "DEVICE_NOT_FOUND", "目标设备未登记")
		return
	}
	if target.State != "online" {
		s.writeError(w, http.StatusConflict, reqID, "DEVICE_OFFLINE", "目标设备当前不在线")
		return
	}

	prefix := "dsk_"
	if kind == "files" {
		prefix = "fil_"
	}
	sessionID := prefix + randomHex(16)
	tunnelID := randomHex(18)
	var tunnel *Tunnel
	var files fileChannel
	if protocol == 5 {
		if s.fileOpen == nil {
			s.writeError(w, http.StatusServiceUnavailable, reqID, "FILE_IDENTITY_UNAVAILABLE", "普通用户文件通道未配置，已拒绝高权限文件操作")
			return
		}
		files, err = s.fileOpen(r.Context(), *target)
	} else {
		tunnel, err = s.mesh.OpenTunnel(r.Context(), target.NodeID, tunnelID, protocol)
	}
	if err != nil {
		s.logger.Warn("device tunnel setup failed", "requestId", reqID, "deviceId", target.ID, "kind", kind, "error", err)
		s.writeError(w, http.StatusBadGateway, reqID, "TUNNEL_SETUP_FAILED", "无法建立设备中继")
		return
	}
	activeSession := &desktopSession{files: files, tunnel: tunnel, created: time.Now(), owner: sessionOwner(r, clientDeviceID), releaseSlot: releaseSlot}
	retained = true
	s.sessions.Store(sessionID, activeSession)
	if p, ok := appidentity.AuthenticatedPrincipal(r.Context()); ok && p.Lifetime != nil {
		stop := context.AfterFunc(p.Lifetime, func() {
			s.sessions.Delete(sessionID)
			s.closeSession(activeSession, websocket.StatusPolicyViolation, "login expired")
		})
		activeSession.mu.Lock()
		activeSession.stopExpiry = stop
		activeSession.mu.Unlock()
	}
	activeSession.mu.Lock()
	activeSession.stopPending = time.AfterFunc(90*time.Second, func() {
		if value, ok := s.sessions.Load(sessionID); ok {
			session := value.(*desktopSession)
			if !session.relayClaimed.Load() {
				s.sessions.Delete(sessionID)
				s.closeSession(session, websocket.StatusPolicyViolation, "session expired")
			}
		}
	})
	activeSession.mu.Unlock()
	identifier := "desktopSessionId"
	basePath := "/api/v1/desktops/"
	if kind == "files" {
		identifier = "fileSessionId"
		basePath = "/api/v1/files/sessions/"
	}
	s.writeJSON(w, http.StatusAccepted, reqID, map[string]any{
		identifier:  sessionID,
		"nodeId":    target.NodeID,
		"tunnelId":  tunnelID,
		"state":     "connecting",
		"relayPath": basePath + sessionID + "/relay",
	}, nil)
}

func remoteTargetDeviceID(id string) bool {
	return id == "echova" || id == "nix" || id == "jiang-chenx" || id == "lerrem"
}

func registeredDeviceID(id string) bool {
	return remoteTargetDeviceID(id) || id == "xiaomi-15"
}

func (s *Server) handleRelay(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("sessionID")
	value, ok := s.sessions.Load(sessionID)
	if !ok {
		http.Error(w, "desktop session not found", http.StatusNotFound)
		return
	}
	session := value.(*desktopSession)
	deviceID, authorized := s.resolveDevice(w, r, requestID())
	if !authorized {
		return
	}
	if session.owner != sessionOwner(r, deviceID) {
		http.Error(w, "session belongs to another caller", http.StatusForbidden)
		return
	}
	if !s.allowedOrigin(r.Header.Get("Origin")) {
		http.Error(w, "untrusted origin", http.StatusForbidden)
		return
	}
	if !session.relayClaimed.CompareAndSwap(false, true) {
		http.Error(w, "desktop relay was already consumed", http.StatusConflict)
		return
	}
	if time.Since(session.created) > 90*time.Second {
		s.sessions.Delete(sessionID)
		s.closeSession(session, websocket.StatusPolicyViolation, "session expired")
		http.Error(w, "desktop session expired", http.StatusGone)
		return
	}

	// 领取之后无论握手、拨号还是转发失败，都必须归还会话资源。
	defer func() {
		s.sessions.Delete(sessionID)
		s.closeSession(session, websocket.StatusNormalClosure, "中继已结束")
	}()
	session.mu.Lock()
	if session.stopPending != nil {
		session.stopPending.Stop()
	}
	session.mu.Unlock()
	client, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: s.originPatterns})
	if err != nil {
		return
	}
	defer client.CloseNow()
	client.SetReadLimit(64 << 20)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return
	}
	session.cancel = cancel
	session.mu.Unlock()
	if session.files != nil {
		_ = session.files.Relay(ctx, client)
		cancel()
		s.sessions.Delete(sessionID)
		s.closeSession(session, websocket.StatusNormalClosure, "文件会话已结束")
		return
	}
	upstream, response, err := websocket.Dial(ctx, s.mesh.RelayURL(session.tunnel), nil)
	if err != nil {
		if response != nil {
			s.logger.Warn("upstream relay rejected", "sessionId", sessionID, "status", response.StatusCode)
		} else {
			s.logger.Warn("upstream relay failed", "sessionId", sessionID, "error", err)
		}
		_ = client.Close(websocket.StatusTryAgainLater, "upstream relay unavailable")
		s.sessions.Delete(sessionID)
		s.closeSession(session, websocket.StatusInternalError, "relay failed")
		return
	}
	defer upstream.CloseNow()
	upstream.SetReadLimit(64 << 20)
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return
	}
	session.upstream = upstream
	session.mu.Unlock()

	errChannel := make(chan error, 3)
	go proxyWebSocket(ctx, upstream, client, errChannel)
	go proxyWebSocket(ctx, client, upstream, errChannel)
	go keepRelayAlive(ctx, client, upstream, errChannel)
	<-errChannel
	cancel()
	s.sessions.Delete(sessionID)
	s.closeSession(session, websocket.StatusNormalClosure, "desktop ended")
}

func (s *Server) handleVendorAsset(w http.ResponseWriter, r *http.Request) {
	asset := r.PathValue("asset")
	allowed := map[string]string{
		"common.js":        "common-0.0.1.js",
		"agent-desktop.js": "agent-desktop-0.0.2.js",
		"agent-redir.js":   "agent-redir-ws-0.1.1.js",
	}
	upstreamName, ok := allowed[asset]
	if !ok {
		http.NotFound(w, r)
		return
	}
	if cached, ok := s.assetCache.Load(upstreamName); ok {
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "private, max-age=3600")
		_, _ = w.Write(cached.([]byte))
		return
	}
	payload, err := s.mesh.PublicAsset(r.Context(), upstreamName)
	if err != nil {
		s.logger.Warn("vendor asset fetch failed", "asset", asset, "error", err)
		http.Error(w, "vendor asset unavailable", http.StatusBadGateway)
		return
	}
	s.assetCache.Store(upstreamName, payload)
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	_, _ = w.Write(payload)
}

func proxyWebSocket(ctx context.Context, destination, source *websocket.Conn, result chan<- error) {
	// 每个方向只保留一个固定缓冲，写端背压直接传到读端。
	buffer := make([]byte, 32<<10)
	for {
		messageType, reader, err := source.Reader(ctx)
		if err != nil {
			result <- err
			return
		}
		writer, err := destination.Writer(ctx, messageType)
		if err != nil {
			result <- err
			return
		}
		if _, err = io.CopyBuffer(writer, reader, buffer); err != nil {
			// 不正常结束部分消息；关闭连接使接收端明确知道传输失败。
			_ = destination.CloseNow()
			result <- err
			return
		}
		if err = writer.Close(); err != nil {
			result <- err
			return
		}
	}
}

func (s *Server) handleEndDesktop(w http.ResponseWriter, r *http.Request) {
	s.handleEndSession(w, r, "desktopSessionId")
}

func (s *Server) handleEndFileSession(w http.ResponseWriter, r *http.Request) {
	s.handleEndSession(w, r, "fileSessionId")
}

func (s *Server) handleEndSession(w http.ResponseWriter, r *http.Request, identifier string) {
	reqID := requestID()
	sessionID := strings.TrimSpace(r.PathValue("sessionID"))
	deviceID, authorized := s.resolveDevice(w, r, reqID)
	if !authorized {
		return
	}
	value, ok := s.sessions.Load(sessionID)
	if ok {
		session := value.(*desktopSession)
		if session.owner != sessionOwner(r, deviceID) {
			s.writeError(w, http.StatusForbidden, reqID, "SESSION_NOT_OWNED", "不能结束其他登录会话的通道")
			return
		}
		s.sessions.Delete(sessionID)
		s.closeSession(session, websocket.StatusNormalClosure, "ended by user")
	}
	s.writeJSON(w, http.StatusOK, reqID, map[string]any{identifier: sessionID, "state": "ended"}, nil)
}

func (s *Server) closeSession(session *desktopSession, status websocket.StatusCode, reason string) {
	if session == nil {
		return
	}
	session.mu.Lock()
	if session.closed {
		session.mu.Unlock()
		return
	}
	session.closed = true
	if session.stopPending != nil {
		session.stopPending.Stop()
	}
	if session.releaseSlot != nil {
		defer session.releaseSlot()
	}
	if session.stopExpiry != nil {
		session.stopExpiry()
	}
	if session.cancel != nil {
		session.cancel()
	}
	session.mu.Unlock()
	if session.files != nil {
		session.files.Close()
	}
	if session.tunnel != nil && session.tunnel.Control != nil {
		_ = session.tunnel.Control.Close(status, reason)
	}
}

func IsNormalClose(err error) bool {
	status := websocket.CloseStatus(err)
	return errors.Is(err, context.Canceled) || status == websocket.StatusNormalClosure || status == websocket.StatusGoingAway
}

func sessionOwner(r *http.Request, deviceID string) string {
	if p, ok := appidentity.AuthenticatedPrincipal(r.Context()); ok {
		return deviceID + ":" + p.SessionID
	}
	return deviceID
}

// 心跳用于保持空闲 HTTPS 代理连接并检测路由丢失，
// 不会重放任何输入或文件消息。
func keepRelayAlive(ctx context.Context, client, upstream *websocket.Conn, result chan<- error) {
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := pingRelayPeers(pingCtx, client.Ping, upstream.Ping)
			cancel()
			if err != nil {
				select {
				case result <- err:
				case <-ctx.Done():
				}
				return
			}
		}
	}
}

// 两段链路同时探测，避免浏览器响应耗尽上游的心跳预算。
// 任一段失败即取消另一段，并等待探测退出。
func pingRelayPeers(ctx context.Context, client, upstream func(context.Context) error) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	results := make(chan error, 2)
	for _, ping := range []func(context.Context) error{client, upstream} {
		go func() { results <- ping(ctx) }()
	}
	var firstError error
	for range 2 {
		if err := <-results; err != nil && firstError == nil {
			firstError = err
			cancel()
		}
	}
	return firstError
}
