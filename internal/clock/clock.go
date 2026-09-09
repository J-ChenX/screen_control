// clock 包负责提供业务包使用的墙上时钟与单调时钟调度抽象。
// 测试通过推进 Manual 时钟运行，无需休眠等待。
package clock

import (
	"sync"
	"time"
)

type Clock interface {
	Now() time.Time
	After(time.Duration) <-chan time.Time
}

type Real struct{}

func (Real) Now() time.Time                             { return time.Now() }
func (Real) After(delay time.Duration) <-chan time.Time { return time.After(delay) }

type waiter struct {
	at time.Time
	ch chan time.Time
}

type Manual struct {
	mu      sync.Mutex
	now     time.Time
	waiters []waiter
}

func NewManual(start time.Time) *Manual { return &Manual{now: start} }

func (clock *Manual) Now() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	return clock.now
}

func (clock *Manual) After(delay time.Duration) <-chan time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	ch := make(chan time.Time, 1)
	if delay <= 0 {
		ch <- clock.now
		return ch
	}
	clock.waiters = append(clock.waiters, waiter{at: clock.now.Add(delay), ch: ch})
	return ch
}

func (clock *Manual) Advance(delta time.Duration) {
	if delta < 0 {
		panic("manual monotonic clock cannot move backwards")
	}
	clock.mu.Lock()
	defer clock.mu.Unlock()
	clock.now = clock.now.Add(delta)
	pending := clock.waiters[:0]
	for _, item := range clock.waiters {
		if item.at.After(clock.now) {
			pending = append(pending, item)
			continue
		}
		item.ch <- clock.now
	}
	clock.waiters = pending
}
