/**
 * Generate a random number between min and max (inclusive)
 * Uses Math.random() which is suitable for jitter calculations
 * (cryptographic randomness not required for backoff jitter)
 */
export function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generate a random number between 0 and max (inclusive)
 */
export function randomUpTo(max: number): number {
  return randomBetween(0, max);
}

/**
 * Generate a random float between min and max
 */
export function randomFloatBetween(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}
