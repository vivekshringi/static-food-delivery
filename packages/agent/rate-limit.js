/**
 * In-memory sliding-window rate limiter.
 *
 * `check` looks at the window without recording anything, so callers can
 * throttle only the events they care about (for example failed verifications)
 * instead of every request. Keys are evicted lazily so a flood of distinct
 * keys cannot grow the map without bound.
 */
export function createRateLimiter({ limit, windowMs, maxKeys = 5000, now = Date.now }) {
  if (!Number.isFinite(limit) || limit <= 0) throw new TypeError("limit must be a positive number");
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new TypeError("windowMs must be a positive number");

  const hits = new Map();

  function recent(key) {
    const cutoff = now() - windowMs;
    const timestamps = (hits.get(key) ?? []).filter((time) => time > cutoff);
    if (timestamps.length === 0) {
      hits.delete(key);
    } else {
      hits.set(key, timestamps);
    }
    return timestamps;
  }

  function evictOldest() {
    const oldestKey = hits.keys().next().value;
    if (oldestKey !== undefined) hits.delete(oldestKey);
  }

  function status(timestamps) {
    if (timestamps.length >= limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((timestamps[0] + windowMs - now()) / 1000)),
      };
    }
    return { allowed: true, remaining: limit - timestamps.length, retryAfterSeconds: 0 };
  }

  /**
   * Reports whether `key` is currently under the limit, without recording a hit.
   */
  function check(key) {
    return status(recent(key));
  }

  /**
   * Records one hit for `key` and reports the resulting status.
   */
  function hit(key) {
    const timestamps = recent(key);
    const result = status(timestamps);
    if (!result.allowed) return result;

    timestamps.push(now());
    hits.set(key, timestamps);
    if (hits.size > maxKeys) evictOldest();
    return { allowed: true, remaining: limit - timestamps.length, retryAfterSeconds: 0 };
  }

  function reset(key) {
    hits.delete(key);
  }

  return { check, hit, reset };
}
