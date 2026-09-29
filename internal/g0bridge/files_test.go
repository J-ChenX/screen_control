package g0bridge

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"screencontrol.local/screen-control/internal/g0files"
)

func TestFileRelayCompletesFramesBeforeDelivery(t *testing.T) {
	input, inputWriter := io.Pipe()
	outputReader, output := io.Pipe()
	defer input.Close()
	defer inputWriter.Close()
	defer output.Close()
	defer outputReader.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		p := &fileProcess{input: inputWriter, output: outputReader}
		_ = p.Relay(r.Context(), c)
	}))
	defer server.Close()
	browser, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer browser.CloseNow()
	browser.SetReadLimit(g0files.MaxFrameSize)
	if _, greeting, err := browser.Read(ctx); err != nil || string(greeting) != "c" {
		t.Fatalf("文件桥接应答失败：%v", err)
	}
	if err := browser.Write(ctx, websocket.MessageText, []byte("5")); err != nil {
		t.Fatal(err)
	}
	frames := [][]byte{bytes.Repeat([]byte{1}, 256<<10), bytes.Repeat([]byte{2}, 256<<10), bytes.Repeat([]byte{3}, 512<<10), []byte("尾帧")}
	writerDone := make(chan error, 1)
	go func() {
		for _, frame := range frames {
			if err := g0files.WriteFrame(output, frame); err != nil {
				writerDone <- err
				return
			}
		}
		var header [4]byte
		binary.BigEndian.PutUint32(header[:], 100)
		_, writeErr := output.Write(header[:])
		if writeErr == nil {
			_, writeErr = output.Write(bytes.Repeat([]byte{9}, 50))
		}
		output.Close()
		writerDone <- writeErr
	}()
	for _, expected := range frames {
		typ, got, err := browser.Read(ctx)
		if err != nil || typ != websocket.MessageBinary || !bytes.Equal(got, expected) {
			t.Fatalf("文件帧被复用或截断：%v", err)
		}
	}
	if err := <-writerDone; err != nil {
		t.Fatal(err)
	}
	if _, got, err := browser.Read(ctx); err == nil {
		t.Fatalf("未收完整的帧被交付：%d", len(got))
	}
}

// 使用真实 WebSocket 验证浏览器在协议号之前发送 RTT 的连接顺序。
func TestFileRelayBrowserHandshake(t *testing.T) {
	input, inputWriter := io.Pipe()
	outputReader, output := io.Pipe()
	defer input.Close()
	defer inputWriter.Close()
	defer output.Close()
	defer outputReader.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		p := &fileProcess{input: inputWriter, output: outputReader}
		_ = p.Relay(r.Context(), c)
	}))
	defer server.Close()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	if err = c.Write(ctx, websocket.MessageText, []byte(`{"ctrlChannel":102938,"type":"rtt"}`)); err != nil {
		t.Fatal(err)
	}
	_, greeting, err := c.Read(ctx)
	if err != nil || string(greeting) != "c" {
		t.Fatalf("连接应答：%q %v", greeting, err)
	}
	if err = c.Write(ctx, websocket.MessageText, []byte("5")); err != nil {
		t.Fatal(err)
	}
	if err = c.Write(ctx, websocket.MessageText, []byte(`{"ctrlChannel":"102938","type":"rtt"}`)); err != nil {
		t.Fatal(err)
	}
	request := `{"action":"ls","path":""}`
	if err = c.Write(ctx, websocket.MessageBinary, []byte(request)); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		data, e := g0files.ReadFrame(input)
		if e == nil && string(data) != request {
			e = io.ErrUnexpectedEOF
		}
		if e == nil {
			e = g0files.WriteFrame(output, []byte(`{"dir":[]}`))
		}
		result <- e
	}()
	_, data, err := c.Read(ctx)
	if err != nil || string(data) != `{"dir":[]}` {
		t.Fatalf("目录消息：%q %v", data, err)
	}
	if err = <-result; err != nil {
		t.Fatal(err)
	}
}

func TestFileRelayRejectsOversizedFrame(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		input, inputWriter := io.Pipe()
		outputReader, output := io.Pipe()
		defer input.Close()
		defer inputWriter.Close()
		defer output.Close()
		defer outputReader.Close()
		p := &fileProcess{input: inputWriter, output: outputReader}
		_ = p.Relay(r.Context(), c)
	}))
	defer server.Close()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	if _, _, err = c.Read(ctx); err != nil {
		t.Fatal(err)
	}
	if err = c.Write(ctx, websocket.MessageText, []byte("5")); err != nil {
		t.Fatal(err)
	}
	// 超限消息应由 WebSocket 入口以 1009 拒绝，无需工作进程读取任何正文。
	_ = c.Write(ctx, websocket.MessageBinary, make([]byte, g0files.MaxFrameSize+1))
	_, _, err = c.Read(ctx)
	if websocket.CloseStatus(err) != websocket.StatusMessageTooBig {
		t.Fatalf("未在入口拒绝超限帧：%v", err)
	}
}
