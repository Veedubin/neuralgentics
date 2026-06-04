/**
 * Boomerang SDK — Utility Functions
 *
 * Helper functions for retry logic, delay, error classification,
 * and common SDK operations.
 */

import type { RetryConfig, RetryableErrorType, SdkResult } from './types.js';

// ============================================================================
// Defaults
// ============================================================================

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  retryableErrors: ['network', 'timeout', 'server', 'rate-limit'],
};

// ============================================================================
// Error Classification
// ============================================================================

/**
 * Classify an error into a retryable error type.
 * Returns null if the error is not retryable.
 */
export function classifyError(error: unknown): RetryableErrorType | null {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();

    if (msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('network')) {
      return 'network';
    }
    if (msg.includes('timeout') || msg.includes('abort') || msg.includes('timed out')) {
      return 'timeout';
    }
    if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) {
      return 'rate-limit';
    }
    if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('server')) {
      return 'server';
    }
  }

  return null;
}

/**
 * Check if an error is retryable based on the provided configuration.
 */
export function isRetryable(error: unknown, retryableErrors: RetryableErrorType[]): boolean {
  const errorType = classifyError(error);
  if (!errorType) return false;
  return retryableErrors.includes(errorType);
}

// ============================================================================
// Retry Logic
// ============================================================================

/**
 * Calculate delay for exponential backoff with jitter.
 */
export function calculateBackoff(attempt: number, config: RetryConfig): number {
  const exponentialDelay = config.baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * config.baseDelayMs;
  return Math.min(exponentialDelay + jitter, config.maxDelayMs);
}

/**
 * Execute an async operation with automatic retry on retryable errors.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  config?: Partial<RetryConfig>
): Promise<T> {
  const fullConfig: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...config };

  let lastError: unknown;

  for (let attempt = 0; attempt < fullConfig.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isRetryable(error, fullConfig.retryableErrors)) {
        throw error;
      }

      if (attempt < fullConfig.maxAttempts - 1) {
        const delay = calculateBackoff(attempt, fullConfig);
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

// ============================================================================
// Async Utilities
// ============================================================================

/**
 * Sleep for a specified number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Result Helpers
// ============================================================================

/**
 * Create a successful SDK result.
 */
export function ok<T>(value: T): SdkResult<T> {
  return { ok: true, value };
}

/**
 * Create a failed SDK result.
 */
export function fail(error: string, retryable = false): SdkResult<never> {
  return { ok: false, error, retryable };
}

/**
 * Wrap an async operation in an SdkResult.
 */
export async function tryOperation<T>(operation: () => Promise<T>): Promise<SdkResult<T>> {
  try {
    const value = await operation();
    return ok(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryable = isRetryable(error, DEFAULT_RETRY_CONFIG.retryableErrors);
    return fail(message, retryable);
  }
}

// ============================================================================
// Identifier Generation
// ============================================================================

/**
 * Generate a unique task/plan ID.
 * Format: {prefix}_{timestamp}_{random}
 */
export function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${timestamp}_${random}`;
}

// ============================================================================
// Map Serialization
// ============================================================================

/**
 * Convert a Map to a plain object for JSON serialization.
 */
export function mapToRecord<K extends string, V>(map: Map<K, V>): Record<K, V> {
  const record = {} as Record<K, V>;
  for (const [key, value] of map.entries()) {
    record[key] = value;
  }
  return record;
}

/**
 * Convert a plain object back to a Map.
 */
export function recordToMap<K extends string, V>(record: Record<K, V>): Map<K, V> {
  const map = new Map<K, V>();
  for (const [key, value] of Object.entries(record) as [K, V][]) {
    map.set(key, value);
  }
  return map;
}