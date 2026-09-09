// gateway 包为专用 HTTPS 网关监听器提供认证，
// 绝不将转发的 IP 或代理请求头视为设备身份。
package gateway

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"html/template"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"screencontrol.local/screen-control/internal/identity"
)

const cookieName = "__Host-screen-control"
const lifetime = 8 * time.Hour

type Credential struct {
	DeviceID string `json:"deviceId"`
	SHA256   string `json:"sha256"`
}
type session struct {
	device  string
	ctx     context.Context
	cancel  context.CancelFunc
	expires time.Time
}
type Gateway struct {
	origin      string
	host        string
	credentials map[[32]byte]string
	mu          sync.Mutex
	sessions    map[[32]byte]*session
	window      time.Time
	attempts    int
}

// Load 要求使用运维人员创建的私有文件，其中包含随机生成的
// 256 位访问密钥的哈希值。不支持人工选择的密码。
func Load(origin, file string) (*Gateway, error) {
	info, err := os.Stat(file)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("gateway credentials must be a regular file with mode 0600")
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	var credentials []Credential
	if err := json.Unmarshal(raw, &credentials); err != nil {
		return nil, errors.New("invalid gateway credential file")
	}
	return New(origin, credentials)
}

func New(origin string, credentials []Credential) (*Gateway, error) {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("gateway origin must be an exact HTTPS origin")
	}
	g := &Gateway{origin: origin, host: u.Host, credentials: make(map[[32]byte]string), sessions: make(map[[32]byte]*session)}
	devices := map[string]bool{}
	for _, c := range credentials {
		if c.DeviceID != "echova" && c.DeviceID != "nix" && c.DeviceID != "jiang-chenx" && c.DeviceID != "xiaomi-15" {
			return nil, errors.New("unknown gateway device")
		}
		b, err := hex.DecodeString(c.SHA256)
		if err != nil || len(b) != 32 || devices[c.DeviceID] {
			return nil, errors.New("invalid or duplicate gateway credential")
		}
		var hash [32]byte
		copy(hash[:], b)
		if _, exists := g.credentials[hash]; exists {
			return nil, errors.New("duplicate gateway key")
		}
		g.credentials[hash] = c.DeviceID
		devices[c.DeviceID] = true
	}
	if len(g.credentials) == 0 {
		return nil, errors.New("gateway needs registered access keys")
	}
	return g, nil
}

// Resolver 仅用于 Handler 后方的专用网关桥接服务。
type Resolver struct{}

func (Resolver) Resolve(ctx context.Context, _, _ net.Addr) (string, error) {
	p, ok := identity.AuthenticatedPrincipal(ctx)
	if !ok {
		return "", identity.ErrUnavailable
	}
	return p.DeviceID, nil
}

func (g *Gateway) Handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Strict-Transport-Security", "max-age=31536000")
		if !strings.EqualFold(r.Host, g.host) {
			http.Error(w, "invalid gateway host", http.StatusMisdirectedRequest)
			return
		}
		// 由隧道终止 TLS 时，需要独立且仅绑定回环地址的监听器。
		// 禁止根据转发请求头推断传输可信性或身份。
		if r.Method != "GET" && r.Method != "HEAD" || strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			if r.Header.Get("Origin") != g.origin {
				http.Error(w, "untrusted origin", http.StatusForbidden)
				return
			}
		}
		if r.URL.Path == "/auth/login" {
			g.login(w, r)
			return
		}
		if r.URL.Path == "/auth/logout" && r.Method == "POST" {
			g.revoke(r)
			http.SetCookie(w, &http.Cookie{Name: cookieName, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: -1})
			http.Redirect(w, r, "/auth/login", http.StatusSeeOther)
			return
		}
		hash, s := g.authenticate(r)
		if s == nil {
			if strings.HasPrefix(r.URL.Path, "/api/") {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte(`{"apiVersion":"v1","error":{"code":"AUTH_REQUIRED","message":"登录已过期，请重新验证访问密钥"}}`))
			} else {
				http.Redirect(w, r, "/auth/login", http.StatusSeeOther)
			}
			return
		}
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		stop := context.AfterFunc(s.ctx, cancel)
		defer stop()
		ctx = identity.WithAuthenticatedPrincipal(ctx, identity.Principal{DeviceID: s.device, SessionID: hex.EncodeToString(hash[:]), Lifetime: s.ctx})
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
func (g *Gateway) authenticate(r *http.Request) ([32]byte, *session) {
	var zero [32]byte
	c, err := r.Cookie(cookieName)
	if err != nil || len(c.Value) != 64 {
		return zero, nil
	}
	hash := sha256.Sum256([]byte(c.Value))
	g.mu.Lock()
	defer g.mu.Unlock()
	s := g.sessions[hash]
	if s != nil && (time.Now().After(s.expires) || s.ctx.Err() != nil) {
		s.cancel()
		delete(g.sessions, hash)
		s = nil
	}
	return hash, s
}
func (g *Gateway) revoke(r *http.Request) {
	hash, s := g.authenticate(r)
	if s == nil {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	s.cancel()
	delete(g.sessions, hash)
}
func (g *Gateway) login(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
	if r.Method == "GET" {
		g.loginPage(w, "")
		return
	}
	if r.Method != "POST" {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	g.mu.Lock()
	now := time.Now()
	if now.Sub(g.window) >= time.Minute {
		g.window = now
		g.attempts = 0
	}
	g.attempts++
	limited := g.attempts > 30
	g.mu.Unlock()
	if limited {
		w.Header().Set("Retry-After", "60")
		http.Error(w, "尝试过于频繁，请稍后重试", http.StatusTooManyRequests)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid form", http.StatusBadRequest)
		return
	}
	key := strings.TrimSpace(r.PostForm.Get("key"))
	decoded, err := hex.DecodeString(key)
	hash := sha256.Sum256([]byte(key))
	device := ""
	if err == nil && len(decoded) == 32 {
		for want, id := range g.credentials {
			if subtle.ConstantTimeCompare(hash[:], want[:]) == 1 {
				device = id
			}
		}
	}
	if device == "" {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusUnauthorized)
		g.loginPage(w, "访问密钥无效，请使用管理员为此设备签发的密钥。")
		return
	}
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		http.Error(w, "session unavailable", http.StatusServiceUnavailable)
		return
	}
	token := hex.EncodeToString(raw[:])
	sessionHash := sha256.Sum256([]byte(token))
	g.revoke(r)
	g.mu.Lock()
	// 限制会话内存占用；无需清理任务也会移除过期会话。
	for k, s := range g.sessions {
		if s.ctx.Err() != nil {
			delete(g.sessions, k)
		}
	}
	if len(g.sessions) >= 128 {
		g.mu.Unlock()
		http.Error(w, "too many sessions", http.StatusTooManyRequests)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), lifetime)
	g.sessions[sessionHash] = &session{device: device, ctx: ctx, cancel: cancel, expires: now.Add(lifetime)}
	g.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: token, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: int(lifetime.Seconds())})
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

var page = template.Must(template.New("login").Parse(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · Screen Control</title><style>body{margin:0;background:#f4f6f8;color:#182230;font:16px system-ui}main{max-width:420px;margin:12vh auto;padding:32px;background:white;border:1px solid #dde3ea;border-radius:16px}input,button{box-sizing:border-box;width:100%;padding:14px;margin-top:12px;border-radius:8px;border:1px solid #bac6d3;font:inherit}button{background:#1649d8;color:white;cursor:pointer}button:hover{background:#123bb1}p,small{line-height:1.7;color:#556476}.error{color:#b42318}@media(max-width:520px){main{margin:8vh 16px;padding:24px}}</style><main><small>SCREEN CONTROL</small><h1>登录私人远控</h1><p>输入管理员为这台设备签发的访问密钥。验证后可查看设备、使用桌面和文件通道。</p><form method="post" action="/auth/login"><label for="key">设备访问密钥</label><input id="key" name="key" type="password" required maxlength="64" autocomplete="current-password"><button>验证并进入</button></form>{{if .}}<p class="error" role="alert">{{.}}</p>{{end}}<p>登录有效期为 8 小时。请勿将密钥分享给其他设备或人员。</p></main></html>`))

func (g *Gateway) loginPage(w http.ResponseWriter, message string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
	_ = page.Execute(w, message)
}
