# resilient-http

A zero-dependency library for resilient HTTP operations with retry logic, circuit breaker, and error extraction.

Works with **Node.js**, **Bun**, and **browsers**.

## Features

- **Retry with Backoff**: Exponential, linear, and constant backoff strategies
- **Jitter Algorithms**: Full, equal, decorrelated, and none (prevents thundering herd)
- **Circuit Breaker**: Prevent cascading failures with automatic state management
- **Error Extraction**: Standardize errors from Axios, Fetch, Got, Undici, and more
- **Zero Dependencies**: No external runtime dependencies
- **Tree-Shakeable**: Import only what you need
- **TypeScript First**: Full type definitions included
- **Cross-Platform**: Works in Node.js, Bun, and browsers

## Installation

```bash
# npm
npm install resilient-http

# yarn
yarn add resilient-http

# bun
bun add resilient-http
```

## Quick Start

```typescript
import { retry, CircuitBreaker, extractError } from 'resilient-http';

// Simple retry
const data = await retry(() => fetch('/api/data').then(r => r.json()));

// With options
const result = await retry(
  () => fetch('/api/data'),
  {
    maxAttempts: 5,
    initialDelay: 1000,
    backoffStrategy: 'exponential',
    jitter: 'full',
  }
);
```

## Retry

The `retry` function wraps async operations with automatic retry logic.

```typescript
import { retry } from 'resilient-http';

const result = await retry(
  () => fetch('/api/data'),
  {
    maxAttempts: 3,           // Maximum retry attempts (default: 3)
    initialDelay: 1000,       // Initial delay in ms (default: 1000)
    maxDelay: 30000,          // Maximum delay cap (default: 30000)
    backoffStrategy: 'exponential', // 'exponential' | 'linear' | 'constant'
    backoffMultiplier: 2,     // Multiplier for backoff (default: 2)
    jitter: 'full',           // 'full' | 'equal' | 'decorrelated' | 'none'
    timeout: 5000,            // Timeout per attempt in ms (optional)

    // Callbacks
    onRetry: (error, attempt, delay) => {
      console.log(`Retry ${attempt} in ${delay}ms`);
    },
    onFailure: (error, attempts) => {
      console.log(`Failed after ${attempts} attempts`);
    },

    // Custom retry predicate
    shouldRetry: (error, attempt) => {
      const { isRetryable } = extractError(error);
      return isRetryable;
    },
  }
);
```

### Retry with Abort Signal

```typescript
import { retryWithSignal } from 'resilient-http';

const controller = new AbortController();

// Cancel after 10 seconds
setTimeout(() => controller.abort(), 10000);

try {
  const result = await retryWithSignal(
    () => fetch('/api/data', { signal: controller.signal }),
    controller.signal,
    { maxAttempts: 5 }
  );
} catch (error) {
  if (error.name === 'AbortError') {
    console.log('Request cancelled');
  }
}
```

### Create Retryable Function

```typescript
import { withRetry } from 'resilient-http';

const fetchWithRetry = withRetry(
  async (url: string) => {
    const response = await fetch(url);
    return response.json();
  },
  { maxAttempts: 3 }
);

// Use like normal function
const data = await fetchWithRetry('/api/data');
```

## Circuit Breaker

Prevents cascading failures by monitoring success/failure rates.

```typescript
import { CircuitBreaker, CircuitBreakerOpenError } from 'resilient-http';

const breaker = new CircuitBreaker({
  failureThreshold: 50,     // Open at 50% failure rate (default: 50)
  minimumRequests: 10,      // Need 10 requests before opening (default: 10)
  rollingWindow: 60000,     // Track failures over 60s (default: 60000)
  resetTimeout: 30000,      // Try again after 30s (default: 30000)
  successThreshold: 3,      // Successes needed to close (default: 3)

  // State change callbacks
  onOpen: () => console.log('Circuit opened!'),
  onClose: () => console.log('Circuit closed!'),
  onHalfOpen: () => console.log('Circuit half-open, testing...'),
});

try {
  const result = await breaker.execute(() => fetch('/api/data'));
} catch (error) {
  if (error instanceof CircuitBreakerOpenError) {
    // Service is unavailable, use fallback
    return getCachedData();
  }
  throw error;
}

// Get metrics
const metrics = breaker.getMetrics();
console.log(`State: ${metrics.state}`);
console.log(`Failure rate: ${metrics.failureRate}%`);
```

### Circuit Breaker Wrapper

```typescript
import { withCircuitBreaker } from 'resilient-http';

const fetchWithBreaker = withCircuitBreaker(
  async (url: string) => fetch(url),
  { failureThreshold: 50 }
);

const response = await fetchWithBreaker('/api/data');
```

## Error Extraction

Standardize errors from any HTTP client.

```typescript
import { extractError } from 'resilient-http';

try {
  await axios.get('/api/data');
} catch (error) {
  const standardized = extractError(error);

  console.log(standardized.message);        // Human-readable message
  console.log(standardized.statusCode);     // HTTP status (if available)
  console.log(standardized.classification); // 'network' | 'timeout' | 'server' | etc.
  console.log(standardized.isRetryable);    // Whether retry is recommended
  console.log(standardized.clientType);     // 'axios' | 'fetch' | 'got' | etc.
}
```

### Supported Clients

- **Axios**: Full error extraction including response data
- **Fetch API**: Network and response errors
- **Got**: HTTP and request errors
- **Undici**: Native Node.js fetch errors
- **node-fetch**: Legacy fetch implementation
- **Generic**: Any Error-like object

### Error Classifications

| Classification | Description | Retryable |
|----------------|-------------|-----------|
| `network` | Network connectivity issues | Yes |
| `timeout` | Request timeout | Yes |
| `server` | 5xx server errors | Yes |
| `rate-limit` | 429 Too Many Requests | Yes |
| `client` | 4xx client errors | No |
| `authentication` | 401, 403 errors | No |
| `not-found` | 404 errors | No |
| `validation` | 400, 422 errors | No |
| `cancelled` | Request cancelled | No |
| `unknown` | Unable to classify | No |

## Backoff Strategies

```typescript
import { calculateBackoff, exponentialBackoff, linearBackoff } from 'resilient-http';

// Exponential: delay = initialDelay * (multiplier ^ attempt)
const delay1 = exponentialBackoff(2, {
  initialDelay: 1000,
  maxDelay: 30000,
  multiplier: 2,
  strategy: 'exponential',
}); // 4000ms

// Linear: delay = initialDelay + (multiplier * attempt * initialDelay)
const delay2 = linearBackoff(2, {
  initialDelay: 1000,
  maxDelay: 30000,
  multiplier: 1,
  strategy: 'linear',
}); // 3000ms

// Using the unified function
const delay = calculateBackoff(2, { strategy: 'exponential' });
```

## Jitter Strategies

Add randomness to prevent thundering herd problems.

```typescript
import { applyJitter, fullJitter, equalJitter } from 'resilient-http';

// Full jitter (AWS recommended): random between 0 and delay
const delay1 = fullJitter(1000); // 0-1000ms

// Equal jitter: 50% fixed + 50% random
const delay2 = equalJitter(1000); // 500-1000ms

// Apply jitter to calculated backoff
const finalDelay = applyJitter(baseDelay, 'full');
```

## Combining Retry and Circuit Breaker

```typescript
import { retry, CircuitBreaker, CircuitBreakerOpenError } from 'resilient-http';

const breaker = new CircuitBreaker({ failureThreshold: 50 });

async function fetchWithResilience(url: string) {
  return breaker.execute(() =>
    retry(
      () => fetch(url).then(r => r.json()),
      { maxAttempts: 3 }
    )
  );
}

try {
  const data = await fetchWithResilience('/api/data');
} catch (error) {
  if (error instanceof CircuitBreakerOpenError) {
    return getFallbackData();
  }
  throw error;
}
```

## API Reference

### Retry Functions

- `retry<T>(fn, options?)` - Execute with retry
- `retryWithSignal<T>(fn, signal, options?)` - Execute with abort support
- `withRetry<T>(fn, options?)` - Create retryable wrapper

### Circuit Breaker

- `CircuitBreaker` - Circuit breaker class
- `CircuitBreakerOpenError` - Error thrown when circuit is open
- `withCircuitBreaker(fn, options?)` - Create protected wrapper

### Error Extraction

- `extractError(error)` - Standardize any error
- `detectClientType(error)` - Detect HTTP client type
- `classifyError(statusCode?, errorCode?)` - Classify error
- `isRetryableError(classification, statusCode?)` - Check if retryable
- `createErrorPredicate(fn)` - Create custom retry predicate
- `defaultRetryPredicate(error)` - Default retry logic

### Backoff Functions

- `calculateBackoff(attempt, config?)` - Calculate backoff delay
- `exponentialBackoff(attempt, config)` - Exponential backoff
- `linearBackoff(attempt, config)` - Linear backoff
- `constantBackoff(attempt, config)` - Constant delay

### Jitter Functions

- `applyJitter(delay, strategy, options?)` - Apply jitter
- `fullJitter(delay)` - Full random jitter
- `equalJitter(delay)` - 50% fixed + 50% random
- `decorrelatedJitter(prev, initial, max)` - Decorrelated jitter
- `noJitter(delay)` - No jitter (passthrough)

### Utilities

- `sleep(ms)` - Promise-based delay
- `sleepWithAbort(ms, signal?)` - Delay with abort support
- `randomBetween(min, max)` - Random integer
- `randomFloatBetween(min, max)` - Random float

## TypeScript

Full TypeScript support with exported types:

```typescript
import type {
  RetryOptions,
  CircuitBreakerOptions,
  CircuitState,
  CircuitMetrics,
  StandardizedError,
  ErrorClassification,
  BackoffStrategy,
  JitterStrategy,
} from 'resilient-http';
```

## License

MIT
