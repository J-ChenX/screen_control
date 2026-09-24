package g0bridge

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func socketPair(t testing.TB) (*websocket.Conn, *websocket.Conn) {
	t.Helper()
	accepted := make(chan *websocket.Conn, 1)
	done := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		accepted <- conn
		<-done
	}))
	client, _, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	peer := <-accepted
	client.SetReadLimit(64 << 20)
	peer.SetReadLimit(64 << 20)
	t.Cleanup(func() { client.CloseNow(); peer.CloseNow(); close(done); server.Close() })
	return client, peer
}

func TestRelayStreamsBeforeMessageCompletes(t *testing.T) {
	source, sender := socketPair(t)
	destination, receiver := socketPair(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result := make(chan error, 1)
	go proxyWebSocket(ctx, destination, source, result)
	writer, err := sender.Writer(ctx, websocket.MessageBinary)
	if err != nil {
		t.Fatal(err)
	}
	prefix := bytes.Repeat([]byte{42}, 128<<10)
	written := make(chan error, 1)
	go func() { _, err := writer.Write(prefix); written <- err }()
	kind, reader, err := receiver.Reader(ctx)
	if err != nil {
		t.Fatal(err)
	}
	got := make([]byte, 32<<10)
	if _, err = io.ReadFull(reader, got); err != nil {
		t.Fatal(err)
	}
	if kind != websocket.MessageBinary || !bytes.Equal(got, prefix[:len(got)]) {
		t.Fatal("流式片段不一致")
	}
	if err = <-written; err != nil {
		t.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	tail, err := io.ReadAll(reader)
	if err != nil || !bytes.Equal(append(got, tail...), prefix) {
		t.Fatalf("消息不完整：%v", err)
	}
	cancel()
	select {
	case <-result:
	case <-time.After(time.Second):
		t.Fatal("取消后转发未退出")
	}
}

func TestFailedRelayHandshakeReleasesSession(t *testing.T) {
	s := NewServerWithIdentity(&fakeMesh{}, fakeIdentity("echova"), nil)
	s.sessionSlots <- struct{}{}
	session := &desktopSession{created: time.Now(), owner: "echova", releaseSlot: func() { <-s.sessionSlots }}
	s.sessions.Store("dsk_test", session)
	request := httptest.NewRequest("GET", "/api/v1/desktops/dsk_test/relay", nil)
	request.Header.Set("Origin", "http://127.0.0.1:5173")
	s.Handler().ServeHTTP(httptest.NewRecorder(), request)
	if _, ok := s.sessions.Load("dsk_test"); ok {
		t.Fatal("握手失败后仍保留会话")
	}
	if !session.closed || len(s.sessionSlots) != 0 {
		t.Fatal("会话资源未释放")
	}
}

func TestSessionCapacityAndFailedCreateRelease(t *testing.T) {
	s := NewServerWithIdentity(&fakeMesh{}, fakeIdentity("echova"), nil)
	request := func() int {
		r := httptest.NewRequest("POST", "/api/v1/desktops", strings.NewReader(`{"targetDeviceId":"nix"}`))
		r.Header.Set("Origin", "http://127.0.0.1:5173")
		w := httptest.NewRecorder()
		s.Handler().ServeHTTP(w, r)
		return w.Code
	}
	for i := 0; i < cap(s.sessionSlots); i++ {
		s.sessionSlots <- struct{}{}
	}
	if code := request(); code != 503 {
		t.Fatalf("会话达到上限：%d", code)
	}
	<-s.sessionSlots
	if code := request(); code != 404 {
		t.Fatalf("目标缺失：%d", code)
	}
	if len(s.sessionSlots) != cap(s.sessionSlots)-1 {
		t.Fatal("失败建连占用了配额")
	}
}

func BenchmarkDesktopRelay(b *testing.B) {
	for _, stream := range []bool{false, true} {
		name := "buffered"
		if stream {
			name = "streamed"
		}
		b.Run(name, func(b *testing.B) {
			source, sender := socketPair(b)
			destination, receiver := socketPair(b)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			result := make(chan error, 1)
			if stream {
				go proxyWebSocket(ctx, destination, source, result)
			} else {
				go func() {
					for {
						kind, data, err := source.Read(ctx)
						if err == nil {
							err = destination.Write(ctx, kind, data)
						}
						if err != nil {
							result <- err
							return
						}
					}
				}()
			}
			data := bytes.Repeat([]byte{42}, 1<<20)
			errCh := make(chan error, 1)
			b.ReportAllocs()
			b.SetBytes(int64(len(data)))
			b.ResetTimer()
			go func() {
				for i := 0; i < b.N; i++ {
					if err := sender.Write(ctx, websocket.MessageBinary, data); err != nil {
						errCh <- err
						return
					}
				}
				errCh <- nil
			}()
			for i := 0; i < b.N; i++ {
				_, r, err := receiver.Reader(ctx)
				if err != nil {
					b.Fatal(err)
				}
				if _, err = io.Copy(io.Discard, r); err != nil {
					b.Fatal(err)
				}
			}
			if err := <-errCh; err != nil {
				b.Fatal(err)
			}
			b.StopTimer()
			cancel()
			<-result
		})
	}
}
