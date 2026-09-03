package clock

import (
	"testing"
	"time"
)

func TestManualBoundaryAndTimer(t *testing.T) {
	start := time.Date(2026, 9, 3, 0, 0, 0, 0, time.UTC)
	clock := NewManual(start)
	timer := clock.After(7 * 24 * time.Hour)
	clock.Advance(7*24*time.Hour - time.Nanosecond)
	select {
	case <-timer:
		t.Fatal("timer fired before the absolute boundary")
	default:
	}
	clock.Advance(time.Nanosecond)
	select {
	case got := <-timer:
		if !got.Equal(start.Add(7 * 24 * time.Hour)) {
			t.Fatalf("unexpected timer value: %s", got)
		}
	default:
		t.Fatal("timer did not fire at the boundary")
	}
}

func TestManualRejectsMonotonicRollback(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected rollback panic")
		}
	}()
	NewManual(time.Unix(0, 0)).Advance(-time.Second)
}
