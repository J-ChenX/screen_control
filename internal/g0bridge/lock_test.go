package g0bridge

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestLockExitOwnershipAndDelivery(t *testing.T) {
	for _, scenario := range []string{"lock", "return", "foreign", "file", "inactive", "closed"} {
		t.Run(scenario, func(t *testing.T) {
			received := make(chan string, 2)
			upstreamServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := websocket.Accept(w, r, nil)
				if err != nil {
					return
				}
				defer conn.CloseNow()
				for {
					_, data, err := conn.Read(r.Context())
					if err != nil {
						return
					}
					received <- string(data)
				}
			}))
			defer upstreamServer.Close()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second*5)
			defer cancel()
			conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(upstreamServer.URL, "http"), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.CloseNow()
			s := NewServerWithIdentity(&fakeMesh{}, fakeIdentity("echova"), slog.New(slog.NewTextHandler(io.Discard, nil)))
			req := httptest.NewRequest("POST", "/api/v1/desktops/dsk_test/lock-exit", strings.NewReader("{}"))
			req.Header.Set("Origin", "http://127.0.0.1:5173")
			session := &desktopSession{owner: sessionOwner(req, "echova"), tunnel: &Tunnel{Protocol: 2}, upstream: conn}
			expected := http.StatusOK
			switch scenario {
			case "return":
				req = httptest.NewRequest("POST", "/api/v1/desktops/dsk_test/end", nil)
				req.Header.Set("Origin", "http://127.0.0.1:5173")
			case "foreign":
				session.owner = "other"
				expected = http.StatusForbidden
			case "file":
				session.files = fakeFileChannel{}
				expected = http.StatusConflict
			case "inactive":
				session.upstream = nil
				expected = http.StatusConflict
			case "closed":
				session.closed = true
				expected = http.StatusConflict
			}
			s.sessions.Store("dsk_test", session)
			response := httptest.NewRecorder()
			s.Handler().ServeHTTP(response, req)
			if response.Code != expected {
				t.Fatalf("状态 %d: %s", response.Code, response.Body.String())
			}
			if scenario == "lock" {
				select {
				case data := <-received:
					if data != `{"ctrlChannel":"102938","type":"lock"}` {
						t.Fatal(data)
					}
				case <-ctx.Done():
					t.Fatal("未收到锁屏指令")
				}
				if !strings.Contains(response.Body.String(), `"status":"unknown"`) {
					t.Fatal("不能把写入成功视为已锁屏")
				}
				retry := httptest.NewRecorder()
				s.Handler().ServeHTTP(retry, req)
				if retry.Code != http.StatusGone {
					t.Fatal("重复请求不应再次发送")
				}
			}
			select {
			case data := <-received:
				t.Fatalf("意外锁屏指令: %s", data)
			default:
			}
		})
	}
}
