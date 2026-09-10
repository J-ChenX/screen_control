package g0bridge

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/coder/websocket"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"screencontrol.local/screen-control/internal/identity/gateway"
	"strings"
	"testing"
	"time"
)

type fakeIdentity string

func (identity fakeIdentity) Resolve(context.Context, net.Addr, net.Addr) (string, error) {
	return string(identity), nil
}

type fakeMesh struct {
	openedFile     string
	devices        []Device
	tunnel         *Tunnel
	opened         string
	openedProtocol int
	relayURL       string
}

func (f *fakeMesh) Devices(context.Context) ([]Device, error) { return f.devices, nil }
func (f *fakeMesh) OpenTunnel(_ context.Context, nodeID, tunnelID string, protocol int) (*Tunnel, error) {
	f.opened = nodeID
	f.openedProtocol = protocol
	return &Tunnel{NodeID: nodeID, TunnelID: tunnelID, Protocol: protocol, Cookie: f.tunnel.Cookie}, nil
}
func (f *fakeMesh) RelayURL(*Tunnel) string {
	if f.relayURL != "" {
		return f.relayURL
	}
	return "ws://127.0.0.1/relay"
}
func (f *fakeMesh) PublicAsset(context.Context, string) ([]byte, error) {
	return []byte("/* test asset */"), nil
}

func testServer(mesh MeshClient) http.Handler {
	return testServerForDevice(mesh, "echova")
}

func testServerForDevice(mesh MeshClient, deviceID string, origins ...string) http.Handler {
	server := NewServerWithIdentity(mesh, fakeIdentity(deviceID), slog.New(slog.NewTextHandler(io.Discard, nil)), origins...)
	server.fileOpen = func(_ context.Context, device Device) (fileChannel, error) {
		if fake, ok := mesh.(*fakeMesh); ok {
			fake.openedFile = device.NodeID
		}
		return fakeFileChannel{}, nil
	}
	return server.Handler()
}

func TestCreateFileSessionUsesOrdinaryUserChannel(t *testing.T) {
	mesh := &fakeMesh{
		devices: []Device{{ID: "nix", NodeID: "node/nix", State: "online"}},
		tunnel:  &Tunnel{Cookie: "must-not-leak"},
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/files/sessions", strings.NewReader(`{"targetDeviceId":"nix"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "http://127.0.0.1:5173")
	response := httptest.NewRecorder()
	testServer(mesh).ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"fileSessionId":"fil_`) {
		t.Fatalf("response did not contain a file session: %s", response.Body.String())
	}
	if mesh.openedFile != "node/nix" || mesh.openedProtocol != 0 {
		t.Fatalf("文件会话错误地使用了 Mesh 通道")
	}
}

func TestDeviceIdentityComesFromTrustedResolver(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/v1/identity/device", nil)
	request.Header.Set("X-Forwarded-For", "100.64.0.99")
	request.Header.Set("X-Screen-Control-Device-ID", "jiang-chenx")
	response := httptest.NewRecorder()
	testServerForDevice(&fakeMesh{}, "nix").ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"deviceId":"nix"`) {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
}

func decodeEnvelope(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var result map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestSnapshotReturnsAuthoritativeDevices(t *testing.T) {
	mesh := &fakeMesh{devices: []Device{{ID: "echova", NodeID: "node/one", State: "online"}}}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/control/snapshot", nil)
	response := httptest.NewRecorder()
	testServer(mesh).ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	result := decodeEnvelope(t, response)
	if result["apiVersion"] != "v1" {
		t.Fatalf("apiVersion = %v", result["apiVersion"])
	}
}

func TestCreateDesktopUsesRegisteredOnlineNodeAndHidesRelayCredential(t *testing.T) {
	mesh := &fakeMesh{
		devices: []Device{{ID: "jiang-chenx", NodeID: "node/windows", State: "online"}},
		tunnel:  &Tunnel{Cookie: "must-not-leak"},
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/desktops", strings.NewReader(`{"targetDeviceId":"jiang-chenx"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "http://127.0.0.1:5173")
	response := httptest.NewRecorder()
	testServer(mesh).ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if mesh.opened != "node/windows" {
		t.Fatalf("opened node = %q", mesh.opened)
	}
	if mesh.openedProtocol != 2 {
		t.Fatalf("opened protocol = %d, want 2", mesh.openedProtocol)
	}
	if strings.Contains(response.Body.String(), "must-not-leak") || strings.Contains(response.Body.String(), "auth") {
		t.Fatalf("response exposed a relay credential: %s", response.Body.String())
	}
}

func TestCreateDesktopRejectsPortalDeviceAsTarget(t *testing.T) {
	for _, path := range []string{"/api/v1/desktops"} {
		t.Run(path, func(t *testing.T) {
			mesh := &fakeMesh{devices: []Device{{ID: "nix", NodeID: "node/local", State: "online"}}, tunnel: &Tunnel{}}
			request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"targetDeviceId":"nix"}`))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Origin", "http://127.0.0.1:5173")
			response := httptest.NewRecorder()
			testServerForDevice(mesh, "nix").ServeHTTP(response, request)
			if response.Code != http.StatusConflict {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
			if !strings.Contains(response.Body.String(), `"code":"SELF_TARGET_NOT_ALLOWED"`) {
				t.Fatalf("response did not reject self target: %s", response.Body.String())
			}
			if mesh.opened != "" {
				t.Fatalf("opened local tunnel %q", mesh.opened)
			}
		})
	}
}

func TestCreateSessionAcceptsServerDeviceForRemoteClient(t *testing.T) {
	mesh := &fakeMesh{devices: []Device{{ID: "echova", NodeID: "node/server", State: "online"}}, tunnel: &Tunnel{}}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/desktops", strings.NewReader(`{"targetDeviceId":"echova"}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", "http://127.0.0.1:5173")
	response := httptest.NewRecorder()
	testServerForDevice(mesh, "nix").ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if mesh.opened != "node/server" {
		t.Fatalf("opened node = %q", mesh.opened)
	}
}

func TestWriteRequestRejectsForeignOrigin(t *testing.T) {
	mesh := &fakeMesh{tunnel: &Tunnel{}}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/desktops", strings.NewReader(`{"targetDeviceId":"echova"}`))
	request.Header.Set("Origin", "https://example.test")
	response := httptest.NewRecorder()
	testServer(mesh).ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
}

func TestWriteRequestRejectsMissingOrigin(t *testing.T) {
	mesh := &fakeMesh{tunnel: &Tunnel{}}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/files/sessions", strings.NewReader(`{"targetDeviceId":"echova"}`))
	response := httptest.NewRecorder()
	testServer(mesh).ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
}

func TestTailnetOriginCanCreateFileSession(t *testing.T) {
	mesh := &fakeMesh{
		devices: []Device{{ID: "nix", NodeID: "node/nix", State: "online"}},
		tunnel:  &Tunnel{},
	}
	server := testServerForDevice(mesh, "echova", "http://100.64.0.20:5174")
	request := httptest.NewRequest(http.MethodPost, "/api/v1/files/sessions", strings.NewReader(`{"targetDeviceId":"nix"}`))
	request.Header.Set("Origin", "http://100.64.0.20:5174")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestCreateSessionRejectsClientSuppliedIdentity(t *testing.T) {
	mesh := &fakeMesh{devices: []Device{{ID: "nix", NodeID: "node/nix", State: "online"}}, tunnel: &Tunnel{}}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/desktops", strings.NewReader(`{"targetDeviceId":"nix","clientDeviceId":"jiang-chenx"}`))
	request.Header.Set("Origin", "http://127.0.0.1:5173")
	response := httptest.NewRecorder()
	testServer(mesh).ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), `"code":"INVALID_REQUEST"`) {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestMobileControllerCanOpenDesktopAndFiles(t *testing.T) {
	for path, protocol := range map[string]int{"/api/v1/desktops": 2, "/api/v1/files/sessions": 5} {
		mesh := &fakeMesh{devices: []Device{{ID: "nix", NodeID: "node/nix", State: "online"}}, tunnel: &Tunnel{}}
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"targetDeviceId":"nix"}`))
		request.Header.Set("Origin", "http://127.0.0.1:5173")
		response := httptest.NewRecorder()
		testServerForDevice(mesh, "xiaomi-15").ServeHTTP(response, request)
		if response.Code != http.StatusAccepted || (protocol == 2 && mesh.openedProtocol != 2) || (protocol == 5 && (mesh.openedFile != "node/nix" || mesh.openedProtocol != 0)) {
			t.Fatalf("mobile session: %d %s", response.Code, response.Body.String())
		}
	}
}

func TestMobileCannotBecomeRemoteTarget(t *testing.T) {
	for _, path := range []string{"/api/v1/desktops", "/api/v1/files/sessions"} {
		mesh := &fakeMesh{devices: []Device{{ID: "xiaomi-15", NodeID: "node/mobile", State: "online"}}, tunnel: &Tunnel{}}
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"targetDeviceId":"xiaomi-15"}`))
		request.Header.Set("Origin", "http://127.0.0.1:5173")
		response := httptest.NewRecorder()
		testServer(mesh).ServeHTTP(response, request)
		if response.Code != http.StatusForbidden || mesh.opened != "" {
			t.Fatalf("mobile target accepted: %d %s", response.Code, response.Body.String())
		}
	}
}

func TestSessionOwnershipCannotBeBypassed(t *testing.T) {
	mesh := &fakeMesh{devices: []Device{{ID: "nix", NodeID: "node/nix", State: "online"}}, tunnel: &Tunnel{}}
	server := NewServerWithIdentity(mesh, fakeIdentity("echova"), nil)
	request := httptest.NewRequest("POST", "/api/v1/desktops", strings.NewReader(`{"targetDeviceId":"nix"}`))
	request.Header.Set("Origin", "http://127.0.0.1:5173")
	w := httptest.NewRecorder()
	server.Handler().ServeHTTP(w, request)
	data := decodeEnvelope(t, w)["data"].(map[string]any)
	id := data["desktopSessionId"].(string)
	server.identity = fakeIdentity("jiang-chenx")
	for _, action := range []string{"relay", "end"} {
		method := "GET"
		if action == "end" {
			method = "POST"
		}
		r := httptest.NewRequest(method, "/api/v1/desktops/"+id+"/"+action, nil)
		r.Header.Set("Origin", "http://127.0.0.1:5173")
		out := httptest.NewRecorder()
		server.Handler().ServeHTTP(out, r)
		if out.Code != 403 {
			t.Fatalf("foreign %s allowed: %d", action, out.Code)
		}
	}
	value, ok := server.sessions.Load(id)
	if !ok || value.(*desktopSession).relayClaimed.Load() {
		t.Fatal("foreign request consumed session")
	}
	server.identity = fakeIdentity("echova")
	r := httptest.NewRequest("POST", "/api/v1/desktops/"+id+"/end", nil)
	r.Header.Set("Origin", "http://127.0.0.1:5173")
	out := httptest.NewRecorder()
	server.Handler().ServeHTTP(out, r)
	if out.Code != 200 {
		t.Fatal(out.Code)
	}
}

// 验证真实的 Cookie、TLS 和 WebSocket 边界，包括使用相同设备凭据
// 进行第二次登录；仅凭身份相同不得认定拥有资源。
func TestGatewayWebSocketOwnershipAndLogout(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		for {
			kind, b, err := c.Read(r.Context())
			if err != nil {
				return
			}
			if c.Write(r.Context(), kind, b) != nil {
				return
			}
		}
	}))
	defer upstream.Close()
	mesh := &fakeMesh{devices: []Device{{ID: "echova", NodeID: "node/server", State: "online"}}, tunnel: &Tunnel{}, relayURL: "ws" + strings.TrimPrefix(upstream.URL, "http")}
	server := httptest.NewTLSServer(http.NotFoundHandler())
	defer server.Close()
	key := strings.Repeat("ab", 32)
	hash := sha256.Sum256([]byte(key))
	auth, err := gateway.New(server.URL, []gateway.Credential{{DeviceID: "nix", SHA256: hex.EncodeToString(hash[:])}})
	if err != nil {
		t.Fatal(err)
	}
	bridge := NewServerWithIdentity(mesh, gateway.Resolver{}, nil, server.URL)
	server.Config.Handler = auth.Handler(bridge.Handler())
	client := server.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	do := func(method, path, body string, cookie *http.Cookie) *http.Response {
		t.Helper()
		r, _ := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		r.Header.Set("Origin", server.URL)
		if path == "/auth/login" {
			r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		} else {
			r.Header.Set("Content-Type", "application/json")
		}
		if cookie != nil {
			r.AddCookie(cookie)
		}
		response, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	login := func() *http.Cookie {
		response := do("POST", "/auth/login", url.Values{"key": {key}}.Encode(), nil)
		defer response.Body.Close()
		if response.StatusCode != 303 {
			t.Fatal(response.StatusCode)
		}
		return response.Cookies()[0]
	}
	first, second := login(), login()
	response := do("POST", "/api/v1/desktops", `{"targetDeviceId":"echova"}`, first)
	var result struct {
		Data struct {
			ID    string `json:"desktopSessionId"`
			Relay string `json:"relayPath"`
		}
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	for _, method := range []string{"GET", "POST"} {
		path := result.Data.Relay
		if method == "POST" {
			path = "/api/v1/desktops/" + result.Data.ID + "/end"
		}
		r := do(method, path, "{}", second)
		r.Body.Close()
		if r.StatusCode != 403 {
			t.Fatalf("second login reached first session: %d", r.StatusCode)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	headers := http.Header{"Origin": {server.URL}, "Cookie": {first.String()}}
	c, _, err := websocket.Dial(ctx, "wss"+strings.TrimPrefix(server.URL, "https")+result.Data.Relay, &websocket.DialOptions{HTTPClient: client, HTTPHeader: headers})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	if err := c.Write(ctx, websocket.MessageBinary, []byte("desktop-frame")); err != nil {
		t.Fatal(err)
	}
	_, data, err := c.Read(ctx)
	if err != nil || string(data) != "desktop-frame" {
		t.Fatalf("relay failed: %s %v", data, err)
	}
	out := do("POST", "/auth/logout", "", first)
	out.Body.Close()
	if _, _, err = c.Read(ctx); err == nil {
		t.Fatal("logout failed to close websocket")
	}
	out = do("GET", "/api/v1/identity/device", "", first)
	out.Body.Close()
	if out.StatusCode != 401 {
		t.Fatal("logged out cookie accepted")
	}
	out = do("POST", "/auth/logout", "", second)
	out.Body.Close()
}

// 文件允许以当前电脑为目标，控屏的自身限制不适用于文件协议。
func TestCreateFileSessionAcceptsPortalDeviceAsTarget(t *testing.T) {
	for _, id := range []string{"echova", "nix", "jiang-chenx"} {
		t.Run(id, func(t *testing.T) {
			mesh := &fakeMesh{devices: []Device{{ID: id, NodeID: "node/local", State: "online"}}, tunnel: &Tunnel{}}
			request := httptest.NewRequest(http.MethodPost, "/api/v1/files/sessions", strings.NewReader(`{"targetDeviceId":"`+id+`"}`))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Origin", "http://127.0.0.1:5173")
			response := httptest.NewRecorder()
			testServerForDevice(mesh, id).ServeHTTP(response, request)
			if response.Code != http.StatusAccepted || mesh.openedFile != "node/local" || mesh.openedProtocol != 0 {
				t.Fatalf("本机文件会话未使用协议 5：status=%d, node=%q, protocol=%d", response.Code, mesh.opened, mesh.openedProtocol)
			}
		})
	}
}

type fakeFileChannel struct{}

func (fakeFileChannel) Relay(context.Context, *websocket.Conn) error { return nil }
func (fakeFileChannel) Close()                                       {}

func TestFileChannelNeverFallsBackToMesh(t *testing.T) {
	mesh := &fakeMesh{devices: []Device{{ID: "nix", NodeID: "node/nix", State: "online"}}, tunnel: &Tunnel{}}
	for _, configured := range []bool{false, true} {
		server := NewServerWithIdentity(mesh, fakeIdentity("echova"), nil)
		if configured {
			if err := server.ConfigureFiles(""); err != nil {
				t.Fatal(err)
			}
		}
		request := httptest.NewRequest(http.MethodPost, "/api/v1/files/sessions", strings.NewReader(`{"targetDeviceId":"nix"}`))
		request.Header.Set("Origin", "http://127.0.0.1:5173")
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, request)
		if response.Code < 500 || mesh.opened != "" {
			t.Fatalf("缺少普通用户配置时仍创建了文件通道：%d", response.Code)
		}
	}
}
func TestFileTargetsRejectRootAndCommandInjection(t *testing.T) {
	for _, value := range []string{"nix=root@host", "nix=user@host;id", "unknown=user@host", "nix=user@host,nix=user@other", "nix=-oProxyCommand=x"} {
		server := NewServerWithIdentity(&fakeMesh{}, fakeIdentity("echova"), nil)
		if server.ConfigureFiles(value) == nil {
			t.Fatalf("接受了非法文件配置 %q", value)
		}
	}
}
