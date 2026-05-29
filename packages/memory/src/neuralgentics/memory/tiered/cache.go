// Package tiered implements L0/L1 summary caching and loading for memory tiers.
// L0 provides ~100 token summaries from high-trust memories (trust >= 0.5).
// L1 provides ~2K token key-decision summaries from highest-trust memories (trust >= 0.8).
package tiered

import (
	"sync"
	"time"
)

// Default TTLs for each tier.
const (
	DefaultL0TTL = 5 * time.Minute
	DefaultL1TTL = 15 * time.Minute
)

// Default cache keys for each tier.
const (
	CacheKeyL0 = "l0_summary"
	CacheKeyL1 = "l1_summary"
)

// cacheEntry holds a cached value with an expiration time.
type cacheEntry struct {
	value     string
	expiresAt time.Time
}

// expired returns true if the entry has passed its expiration time.
func (e *cacheEntry) expired() bool {
	return time.Now().After(e.expiresAt)
}

// SummaryCache provides a thread-safe, TTL-based in-memory cache for tiered summaries.
// It uses sync.RWMutex for concurrent read access and exclusive write access.
//
// Typical usage:
//
//	cache := tiered.NewSummaryCache()
//	cache.Set("l0_summary", "summary text", tiered.DefaultL0TTL)
//	val, ok := cache.Get("l0_summary")
type SummaryCache struct {
	mu      sync.RWMutex
	entries map[string]*cacheEntry
}

// NewSummaryCache creates a new empty SummaryCache.
func NewSummaryCache() *SummaryCache {
	return &SummaryCache{
		entries: make(map[string]*cacheEntry),
	}
}

// Get retrieves a cached value by key.
// Returns the value and true if the key exists and has not expired.
// Returns empty string and false if the key is missing or expired.
// Expired entries are lazily removed on access.
func (c *SummaryCache) Get(key string) (string, bool) {
	c.mu.RLock()
	entry, exists := c.entries[key]
	c.mu.RUnlock()

	if !exists {
		return "", false
	}

	if entry.expired() {
		// Lazily remove the expired entry with a write lock.
		c.mu.Lock()
		// Re-check in case another goroutine already removed it.
		if e, ok := c.entries[key]; ok && e.expired() {
			delete(c.entries, key)
		}
		c.mu.Unlock()
		return "", false
	}

	return entry.value, true
}

// Set stores a value in the cache with the given TTL.
// Overwrites any existing value for the same key.
func (c *SummaryCache) Set(key string, value string, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.entries[key] = &cacheEntry{
		value:     value,
		expiresAt: time.Now().Add(ttl),
	}
}

// Invalidate removes a single key from the cache.
// No-op if the key does not exist.
func (c *SummaryCache) Invalidate(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, key)
}

// InvalidateAll removes all entries from the cache.
func (c *SummaryCache) InvalidateAll() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries = make(map[string]*cacheEntry)
}

// Size returns the number of non-expired entries in the cache.
// This scans all entries and removes expired ones as a side effect.
func (c *SummaryCache) Size() int {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Clean up expired entries.
	now := time.Now()
	for k, e := range c.entries {
		if now.After(e.expiresAt) {
			delete(c.entries, k)
		}
	}
	return len(c.entries)
}
