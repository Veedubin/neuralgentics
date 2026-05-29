package tiered

import (
	"sync"
	"testing"
	"time"
)

func TestNewSummaryCache(t *testing.T) {
	cache := NewSummaryCache()
	if cache == nil {
		t.Fatal("NewSummaryCache returned nil")
	}
	if cache.Size() != 0 {
		t.Errorf("expected empty cache, got Size() = %d", cache.Size())
	}
}

func TestCacheSetAndGet(t *testing.T) {
	cache := NewSummaryCache()

	cache.Set("key1", "value1", 5*time.Minute)

	val, ok := cache.Get("key1")
	if !ok {
		t.Error("expected key1 to be found")
	}
	if val != "value1" {
		t.Errorf("val = %q, want %q", val, "value1")
	}
}

func TestCacheGet_MissingKey(t *testing.T) {
	cache := NewSummaryCache()

	val, ok := cache.Get("nonexistent")
	if ok {
		t.Error("expected key to be missing")
	}
	if val != "" {
		t.Errorf("val = %q, want empty string", val)
	}
}

func TestCacheSet_Overwrite(t *testing.T) {
	cache := NewSummaryCache()

	cache.Set("key1", "old value", 5*time.Minute)
	cache.Set("key1", "new value", 5*time.Minute)

	val, ok := cache.Get("key1")
	if !ok {
		t.Error("expected key1 to be found")
	}
	if val != "new value" {
		t.Errorf("val = %q, want %q", val, "new value")
	}
}

func TestCacheGet_Expired(t *testing.T) {
	cache := NewSummaryCache()

	// Set with a very short TTL.
	cache.Set("key1", "expired value", 1*time.Millisecond)

	// Wait for expiry.
	time.Sleep(10 * time.Millisecond)

	val, ok := cache.Get("key1")
	if ok {
		t.Error("expected expired key to not be found")
	}
	if val != "" {
		t.Errorf("val = %q, want empty string for expired entry", val)
	}
}

func TestCacheGet_ExpiredCleanup(t *testing.T) {
	cache := NewSummaryCache()

	// Set with a short TTL.
	cache.Set("key1", "will expire", 1*time.Millisecond)
	cache.Set("key2", "stays valid", 5*time.Minute)

	// Wait for key1 to expire.
	time.Sleep(10 * time.Millisecond)

	// Accessing key1 should clean it up.
	_, ok := cache.Get("key1")
	if ok {
		t.Error("expected expired key1 to not be found")
	}

	// key2 should still be valid.
	val, ok := cache.Get("key2")
	if !ok {
		t.Error("expected key2 to still be valid")
	}
	if val != "stays valid" {
		t.Errorf("val = %q, want %q", val, "stays valid")
	}
}

func TestCacheInvalidate(t *testing.T) {
	cache := NewSummaryCache()

	cache.Set("key1", "value1", 5*time.Minute)
	cache.Set("key2", "value2", 5*time.Minute)

	cache.Invalidate("key1")

	_, ok := cache.Get("key1")
	if ok {
		t.Error("expected key1 to be invalidated")
	}

	val, ok := cache.Get("key2")
	if !ok {
		t.Error("expected key2 to still be valid")
	}
	if val != "value2" {
		t.Errorf("val = %q, want %q", val, "value2")
	}
}

func TestCacheInvalidate_NonexistentKey(t *testing.T) {
	cache := NewSummaryCache()

	// Should not panic on non-existent key.
	cache.Invalidate("nonexistent")

	cache.Set("key1", "value1", 5*time.Minute)
	cache.Invalidate("key1")

	_, ok := cache.Get("key1")
	if ok {
		t.Error("expected key1 to be invalidated")
	}
}

func TestCacheInvalidateAll(t *testing.T) {
	cache := NewSummaryCache()

	cache.Set("l0_summary", "L0 content", DefaultL0TTL)
	cache.Set("l1_summary", "L1 content", DefaultL1TTL)
	cache.Set("extra_key", "extra value", 10*time.Minute)

	cache.InvalidateAll()

	if cache.Size() != 0 {
		t.Errorf("expected Size() = 0 after InvalidateAll, got %d", cache.Size())
	}

	_, ok1 := cache.Get("l0_summary")
	_, ok2 := cache.Get("l1_summary")
	_, ok3 := cache.Get("extra_key")
	if ok1 || ok2 || ok3 {
		t.Error("expected all keys to be invalidated")
	}
}

func TestCacheSize(t *testing.T) {
	cache := NewSummaryCache()

	if cache.Size() != 0 {
		t.Errorf("expected Size() = 0, got %d", cache.Size())
	}

	cache.Set("key1", "value1", 5*time.Minute)
	cache.Set("key2", "value2", 5*time.Minute)

	if cache.Size() != 2 {
		t.Errorf("expected Size() = 2, got %d", cache.Size())
	}

	cache.Invalidate("key1")

	if cache.Size() != 1 {
		t.Errorf("expected Size() = 1 after invalidation, got %d", cache.Size())
	}
}

func TestCacheSize_RemovesExpired(t *testing.T) {
	cache := NewSummaryCache()

	cache.Set("key1", "value1", 1*time.Millisecond)
	cache.Set("key2", "value2", 5*time.Minute)

	// Wait for key1 to expire.
	time.Sleep(10 * time.Millisecond)

	// Size() should remove expired entries and return 1.
	if cache.Size() != 1 {
		t.Errorf("expected Size() = 1 after expiry, got %d", cache.Size())
	}
}

func TestCacheConcurrent(t *testing.T) {
	cache := NewSummaryCache()
	var wg sync.WaitGroup

	// Concurrent writes.
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			key := CacheKeyL0
			cache.Set(key, "concurrent value", 5*time.Minute)
		}(i)
	}

	// Concurrent reads.
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			cache.Get(CacheKeyL0)
		}()
	}

	wg.Wait()

	// Verify the final state is valid.
	val, ok := cache.Get(CacheKeyL0)
	if !ok {
		t.Error("expected key to exist after concurrent operations")
	}
	if val != "concurrent value" {
		t.Errorf("val = %q, want %q", val, "concurrent value")
	}
}

func TestDefaultConstants(t *testing.T) {
	if DefaultL0TTL != 5*time.Minute {
		t.Errorf("DefaultL0TTL = %v, want %v", DefaultL0TTL, 5*time.Minute)
	}
	if DefaultL1TTL != 15*time.Minute {
		t.Errorf("DefaultL1TTL = %v, want %v", DefaultL1TTL, 15*time.Minute)
	}
	if CacheKeyL0 != "l0_summary" {
		t.Errorf("CacheKeyL0 = %q, want %q", CacheKeyL0, "l0_summary")
	}
	if CacheKeyL1 != "l1_summary" {
		t.Errorf("CacheKeyL1 = %q, want %q", CacheKeyL1, "l1_summary")
	}
}

func TestCacheMultipleSets(t *testing.T) {
	cache := NewSummaryCache()

	// Set L0 and L1 caches.
	cache.Set(CacheKeyL0, "L0 summary", DefaultL0TTL)
	cache.Set(CacheKeyL1, "L1 summary", DefaultL1TTL)

	l0, ok := cache.Get(CacheKeyL0)
	if !ok || l0 != "L0 summary" {
		t.Errorf("L0 = %q, ok = %v, want %q, true", l0, ok, "L0 summary")
	}

	l1, ok := cache.Get(CacheKeyL1)
	if !ok || l1 != "L1 summary" {
		t.Errorf("L1 = %q, ok = %v, want %q, true", l1, ok, "L1 summary")
	}
}

func TestCacheEntry_Expired(t *testing.T) {
	// Test the cacheEntry.expired() method directly.
	past := time.Now().Add(-1 * time.Hour)
	entry := &cacheEntry{value: "test", expiresAt: past}
	if !entry.expired() {
		t.Error("expected past entry to be expired")
	}

	future := time.Now().Add(1 * time.Hour)
	entry = &cacheEntry{value: "test", expiresAt: future}
	if entry.expired() {
		t.Error("expected future entry to not be expired")
	}
}
