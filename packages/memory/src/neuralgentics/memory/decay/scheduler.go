package decay

import (
	"context"
	"sync"
	"time"

	"neuralgentics/src/neuralgentics/memory/core"
)

// Scheduler runs background decay operations on a fixed interval.
// It iterates over all active (non-archived) memories and applies
// exponential trust decay via the DecayEngine.
type Scheduler struct {
	engine   *DecayEngine
	interval time.Duration
	stopCh   chan struct{}
	wg       sync.WaitGroup
	stopOnce sync.Once
}

// NewScheduler creates a new Scheduler with the given engine and tick interval.
// The scheduler does NOT start automatically — call Start() to begin.
func NewScheduler(engine *DecayEngine, interval time.Duration) *Scheduler {
	if interval <= 0 {
		interval = 1 * time.Hour
	}
	return &Scheduler{
		engine:   engine,
		interval: interval,
		stopCh:   make(chan struct{}),
	}
}

// Start begins the background decay goroutine.
func (s *Scheduler) Start() {
	s.wg.Add(1)
	go s.run()
}

// Stop signals the scheduler to stop and waits for the goroutine to finish.
func (s *Scheduler) Stop() {
	s.stopOnce.Do(func() {
		close(s.stopCh)
	})
	s.wg.Wait()
}

// run is the main loop that applies decay on each tick.
func (s *Scheduler) run() {
	defer s.wg.Done()

	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()

	for {
		select {
		case <-s.stopCh:
			return
		case <-ticker.C:
			s.tick(context.Background())
		}
	}
}

// tick applies decay to all active memories.
func (s *Scheduler) tick(ctx context.Context) {
	active, err := s.engine.store.ListMemories(ctx, &core.SearchFilter{
		IsArchived: boolPtr(false),
	}, 0)
	if err != nil {
		return
	}

	for _, m := range active {
		_ = s.engine.ApplyDecay(ctx, m.ID)
	}
}
