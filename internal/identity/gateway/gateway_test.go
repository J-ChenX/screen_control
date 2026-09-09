package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"screencontrol.local/screen-control/internal/identity"
)

const testOrigin = "https://portal.example"
const testKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func testGateway(t *testing.T) *Gateway {
	t.Helper()
	hash := sha256.Sum256([]byte(testKey))
	g, e := New(testOrigin, []Credential{{DeviceID: "nix", SHA256: hex.EncodeToString(hash[:])}})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		g.mu.Lock()
		defer g.mu.Unlock()
		for _, s := range g.sessions {
			s.cancel()
		}
	})
	return g
}
func req(method, path, body string) *http.Request {
	r := httptest.NewRequest(method, testOrigin+path, strings.NewReader(body))
	r.Header.Set("Origin", testOrigin)
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	return r
}
func login(t *testing.T, g *Gateway) *http.Cookie {
	t.Helper()
	w := httptest.NewRecorder()
	g.Handler(http.NotFoundHandler()).ServeHTTP(w, req("POST", "/auth/login", url.Values{"key": {testKey}}.Encode()))
	if w.Code != 303 {
		t.Fatalf("login status %d", w.Code)
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatal("missing cookie")
	}
	return cookies[0]
}
func TestProtectsAllResourcesAndRejectsForgedIdentity(t *testing.T) {
	g := testGateway(t)
	called := false
	h := g.Handler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	for _, path := range []string{"/", "/assets/index.js", "/api/v1/health", "/api/v1/control/snapshot", "/api/v1/vendor/common.js", "/api/v1/desktops/abc/relay"} {
		r := req("GET", path, "")
		r.Header.Set("X-Screen-Control-Device-ID", "nix")
		r.Header.Set("Tailscale-User-Login", "nix")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 303 && w.Code != 401 {
			t.Fatalf("%s exposed: %d", path, w.Code)
		}
	}
	if called {
		t.Fatal("unauthenticated request reached backend")
	}
}
func TestSessionCookieAndTrustedPrincipal(t *testing.T) {
	g := testGateway(t)
	c := login(t, g)
	if !c.Secure || !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Path != "/" || c.Domain != "" || c.MaxAge != 28800 {
		t.Fatalf("unsafe cookie: %+v", c)
	}
	r := req("GET", "/api/v1/identity/device", "")
	r.AddCookie(c)
	w := httptest.NewRecorder()
	g.Handler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, ok := identity.AuthenticatedPrincipal(r.Context())
		if !ok || p.DeviceID != "nix" || p.Lifetime == nil {
			t.Fatal("missing authenticated identity")
		}
		device, err := (Resolver{}).Resolve(r.Context(), nil, nil)
		if err != nil || device != "nix" {
			t.Fatal("resolver failed")
		}
	})).ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
}
func TestRejectsCrossOriginAndWrongHost(t *testing.T) {
	g := testGateway(t)
	c := login(t, g)
	for _, tc := range []struct{ method, path, origin, host, upgrade string }{{"POST", "/auth/login", "https://evil.example", "portal.example", ""}, {"POST", "/auth/logout", "", "portal.example", ""}, {"GET", "/api/v1/desktops/x/relay", "https://evil.example", "portal.example", "websocket"}, {"GET", "/", "https://portal.example", "evil.example", ""}} {
		r := req(tc.method, tc.path, "")
		r.Host = tc.host
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("Upgrade", tc.upgrade)
		r.AddCookie(c)
		w := httptest.NewRecorder()
		g.Handler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Fatal("reached backend") })).ServeHTTP(w, r)
		if w.Code != 403 && w.Code != 421 {
			t.Fatal(w.Code)
		}
	}
}
func TestLogoutCancelsActiveRequests(t *testing.T) {
	g := testGateway(t)
	c := login(t, g)
	started := make(chan struct{})
	done := make(chan struct{})
	h := g.Handler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(started); <-r.Context().Done(); close(done) }))
	r := req("GET", "/api/v1/desktops/x/relay", "")
	r.AddCookie(c)
	go h.ServeHTTP(httptest.NewRecorder(), r)
	<-started
	out := req("POST", "/auth/logout", "")
	out.AddCookie(c)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, out)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("logout left active channel open")
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal("revoked cookie accepted")
	}
}
func TestExpiredSessionRejected(t *testing.T) {
	g := testGateway(t)
	c := login(t, g)
	r := req("GET", "/api/v1/health", "")
	r.AddCookie(c)
	_, s := g.authenticate(r)
	s.cancel()
	w := httptest.NewRecorder()
	g.Handler(http.NotFoundHandler()).ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatal(w.Code)
	}
}
func TestInvalidKeyAndRateLimit(t *testing.T) {
	g := testGateway(t)
	h := g.Handler(http.NotFoundHandler())
	for i := 0; i < 31; i++ {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req("POST", "/auth/login", "key=wrong"))
		want := 401
		if i == 30 {
			want = 429
		}
		if w.Code != want {
			t.Fatalf("attempt %d status %d", i, w.Code)
		}
		if len(w.Result().Cookies()) != 0 {
			t.Fatal("invalid login issued cookie")
		}
	}
}
func TestResolverCannotUseRawRequestContext(t *testing.T) {
	if _, err := (Resolver{}).Resolve(context.Background(), nil, nil); err == nil {
		t.Fatal("unauthenticated resolver accepted")
	}
}
func TestInvalidConfigurationFailsClosed(t *testing.T) {
	for _, origin := range []string{"http://portal.example", "https://portal.example/path", "https://user@portal.example", "https://portal.example?q=x"} {
		if _, err := New(origin, []Credential{{DeviceID: "nix", SHA256: strings.Repeat("a", 64)}}); err == nil {
			t.Fatal(origin)
		}
	}
	if _, err := New(testOrigin, []Credential{{DeviceID: "unknown", SHA256: strings.Repeat("a", 64)}}); err == nil {
		t.Fatal("unknown device accepted")
	}
}
