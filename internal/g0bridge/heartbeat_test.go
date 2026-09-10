package g0bridge

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestRelayPingsRunConcurrently(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	started := make(chan struct{})
	client := func(ctx context.Context) error {
		select {
		case <-started:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	upstream := func(context.Context) error { close(started); return nil }
	if err := pingRelayPeers(ctx, client, upstream); err != nil {
		t.Fatal(err)
	}
}

func TestRelayPingFailureCancelsOtherPeer(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	failure := errors.New("探测失败")
	exited := make(chan struct{})
	err := pingRelayPeers(ctx, func(context.Context) error { return failure }, func(ctx context.Context) error {
		defer close(exited)
		<-ctx.Done()
		return ctx.Err()
	})
	if !errors.Is(err, failure) {
		t.Fatalf("预期原始错误，得到 %v", err)
	}
	select {
	case <-exited:
	default:
		t.Fatal("心跳返回时另一段探测尚未退出")
	}
}

func TestRelayPingsRespectCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	ping := func(ctx context.Context) error { <-ctx.Done(); return ctx.Err() }
	if err := pingRelayPeers(ctx, ping, ping); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}
