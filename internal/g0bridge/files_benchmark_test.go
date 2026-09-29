package g0bridge

import (
	"bytes"
	"context"
	"io"
	"testing"
	"time"

	"github.com/coder/websocket"
	"screencontrol.local/screen-control/internal/g0files"
)

func BenchmarkFileRelayFrames(b *testing.B) {
	browser, portal := socketPair(b)
	input, inputWriter := io.Pipe()
	outputReader, output := io.Pipe()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	defer input.Close()
	defer inputWriter.Close()
	defer output.Close()
	defer outputReader.Close()
	p := &fileProcess{input: inputWriter, output: outputReader}
	relayDone := make(chan error, 1)
	go func() { relayDone <- p.Relay(ctx, portal) }()
	if _, greeting, err := browser.Read(ctx); err != nil || string(greeting) != "c" {
		b.Fatalf("文件桥接应答失败：%v", err)
	}
	if err := browser.Write(ctx, websocket.MessageText, []byte("5")); err != nil {
		b.Fatal(err)
	}
	payload := bytes.Repeat([]byte{0, 123, 255, 42}, 64<<10)
	start := make(chan struct{})
	writerDone := make(chan error, 1)
	go func() {
		<-start
		for i := 0; i < b.N; i++ {
			if err := g0files.WriteFrame(output, payload); err != nil {
				writerDone <- err
				return
			}
		}
		writerDone <- nil
	}()
	b.SetBytes(int64(len(payload)))
	b.ReportAllocs()
	b.ResetTimer()
	close(start)
	for i := 0; i < b.N; i++ {
		typ, data, err := browser.Read(ctx)
		if err != nil || typ != websocket.MessageBinary || !bytes.Equal(data, payload) {
			b.Fatalf("文件帧内容不完整：%v", err)
		}
	}
	if err := <-writerDone; err != nil {
		b.Fatal(err)
	}
	b.StopTimer()
	cancel()
	_ = output.Close()
	<-relayDone
}
