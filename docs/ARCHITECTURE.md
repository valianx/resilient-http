# resilient-http - Architecture Design Document

**Version:** 1.0.0
**Last Updated:** 2025-12-30
**License:** MIT
**Type:** Open-source npm package

---

## Executive Summary

`resilient-http` is a framework-agnostic, zero-dependency HTTP resilience library for Node.js, Bun, and browsers. It provides retry logic with exponential backoff, jitter, circuit breakers, and standardized error extraction across different HTTP clients (Axios, fetch, got, node-fetch, etc.).

**Core Design Principles:**
- Framework agnostic (works with Express, Fastify, NestJS, Bun, browsers)
- Zero required dependencies (RxJS as optional peer dependency)
- Dual module support (ESM primary, CJS fallback)
- Tree-shakeable by design
- TypeScript-first with full type safety
- Bun runtime compatible

---

## Table of Contents

1. [Module Structure](#module-structure)
2. [Public API Design](#public-api-design)
3. [Core Components](#core-components)
4. [Resilience Patterns](#resilience-patterns)
5. [Error Extraction System](#error-extraction-system)
6. [Build Configuration](#build-configuration)
7. [Compatibility Matrix](#compatibility-matrix)
8. [Type Definitions](#type-definitions)
9. [Testing Strategy](#testing-strategy)
10. [Performance Considerations](#performance-considerations)
11. [Research References](#research-references)

---

## Module Structure

```
resilient-http/
├── src/
│   ├── index.ts                          # Main entry point (barrel export)
│   ├── core/
│   │   ├── retry.ts                      # Retry orchestrator
│   │   ├── circuit-breaker.ts            # Circuit breaker implementation
│   │   ├── backoff.ts                    # Backoff strategies (exponential, linear, constant)
│   │   ├── jitter.ts                     # Jitter algorithms (full, equal, decorrelated)
│   │   └── timeout.ts                    # Timeout wrapper
│   ├── error/
│   │   ├── extractor.ts                  # Main error extraction orchestrator
│   │   ├── extractors/
│   │   │   ├── axios-extractor.ts        # Axios error extraction
│   │   │   ├── fetch-extractor.ts        # Fetch API error extraction
│   │   │   ├── got-extractor.ts          # got library error extraction
│   │   │   ├── node-fetch-extractor.ts   # node-fetch error extraction
│   │   │   └── generic-extractor.ts      # Fallback generic extractor
│   │   ├── error-classifier.ts           # Classify errors (transient vs permanent)
│   │   └── standardized-error.ts         # Standardized error model
│   ├── strategies/
│   │   ├── retry-strategy.ts             # Retry decision logic
│   │   ├── should-retry.ts               # Predicate functions for retryability
│   │   └── backoff-calculator.ts         # Calculate wait times
│   ├── observable/                       # Optional RxJS integration
│   │   ├── retry-operator.ts             # RxJS retry operator
│   │   └── circuit-breaker-operator.ts   # RxJS circuit breaker operator
│   ├── utils/
│   │   ├── sleep.ts                      # Promise-based sleep
│   │   ├── random.ts                     # Random number generation (jitter)
│   │   ├── logger.ts                     # Optional logging adapter
│   │   └── type-guards.ts                # Runtime type checking utilities
│   └── types/
│       ├── config.ts                     # Configuration types
│       ├── error.ts                      # Error types
│       ├── http.ts                       # HTTP client types
│       └── index.ts                      # Type barrel export
├── dist/
│   ├── index.js                          # ESM build
│   ├── index.cjs                         # CJS build
│   ├── index.d.ts                        # Type definitions
│   ├── index.d.cts                       # CJS type definitions
│   └── [module-specific builds]         # Individual module outputs
├── tests/
│   ├── unit/                             # Unit tests
│   ├── integration/                      # Integration tests
│   └── compatibility/                    # Runtime compatibility tests
├── docs/
│   ├── ARCHITECTURE.md                   # This file
│   ├── API.md                            # API reference
│   ├── GUIDES.md                         # Usage guides
│   └── MIGRATION.md                      # Migration guides
├── examples/
│   ├── node-express/                     # Express.js example
│   ├── node-fastify/                     # Fastify example
│   ├── nestjs/                           # NestJS example
│   ├── bun/                              # Bun runtime example
│   └── browser/                          # Browser example
├── package.json                          # Package manifest
├── tsconfig.json                         # TypeScript base config
├── tsconfig.build.json                   # Build-specific config
├── tsup.config.ts                        # Build configuration (tsup)
├── .npmignore                            # npm publish exclusions
├── LICENSE                               # MIT License
└── README.md                             # User documentation
```

### Design Rationale

**Modular Architecture:**
- Each component is independently importable for tree-shaking
- Clear separation of concerns (retry, circuit breaker, error extraction)
- No circular dependencies

**Optional RxJS Integration:**
- RxJS operators in separate module (`/observable`)
- Only loaded if user imports from that path
- Declared as peer dependency, not direct dependency

**Client-Agnostic Error Extraction:**
- Strategy pattern for different HTTP client errors
- Auto-detection of error type
- Fallback to generic extraction

---

## Public API Design

### Entry Points

#### Main Entry (`resilient-http`)

```typescript
// Default import - full API
import { retry, CircuitBreaker, extractError } from 'resilient-http';

// Named imports - tree-shakeable
import { retry } from 'resilient-http/core/retry';
import { CircuitBreaker } from 'resilient-http/core/circuit-breaker';
import { extractError } from 'resilient-http/error';
```

#### Observable Entry (`resilient-http/observable`)

```typescript
import { retryWithBackoff } from 'resilient-http/observable';
import { circuitBreakerOperator } from 'resilient-http/observable';
```

### Core API

#### 1. Retry Function (Functional API)

```typescript
/**
 * Retry a function with configurable backoff and jitter
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T>;

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts?: number;

  /** Initial delay in milliseconds (default: 1000) */
  initialDelay?: number;

  /** Maximum delay cap in milliseconds (default: 30000) */
  maxDelay?: number;

  /** Backoff strategy (default: 'exponential') */
  backoffStrategy?: 'exponential' | 'linear' | 'constant';

  /** Backoff multiplier for exponential/linear (default: 2) */
  backoffMultiplier?: number;

  /** Jitter strategy (default: 'full') */
  jitter?: 'full' | 'equal' | 'decorrelated' | 'none';

  /** Custom predicate to determine if error is retryable */
  shouldRetry?: (error: unknown, attempt: number) => boolean;

  /** Timeout for each attempt in milliseconds */
  timeout?: number;

  /** Callback before each retry */
  onRetry?: (error: unknown, attempt: number, nextDelay: number) => void;

  /** Callback on final failure */
  onFailure?: (error: unknown, attempts: number) => void;

  /** Custom logger */
  logger?: Logger;
}
```

#### 2. Circuit Breaker (Class-based API)

```typescript
/**
 * Circuit breaker for HTTP requests
 */
export class CircuitBreaker<T = any> {
  constructor(options?: CircuitBreakerOptions);

  /** Execute function through circuit breaker */
  execute(fn: () => Promise<T>): Promise<T>;

  /** Get current circuit state */
  getState(): CircuitState;

  /** Manually open the circuit */
  open(): void;

  /** Manually close the circuit */
  close(): void;

  /** Reset circuit to closed state */
  reset(): void;

  /** Get circuit metrics */
  getMetrics(): CircuitMetrics;
}

export interface CircuitBreakerOptions {
  /** Failure threshold percentage (default: 50) */
  failureThreshold?: number;

  /** Minimum number of requests before opening circuit (default: 10) */
  minimumRequests?: number;

  /** Time window for tracking failures in ms (default: 60000) */
  rollingWindow?: number;

  /** Time to wait before attempting half-open in ms (default: 30000) */
  resetTimeout?: number;

  /** Number of successful requests to close from half-open (default: 3) */
  successThreshold?: number;

  /** Callback when circuit opens */
  onOpen?: () => void;

  /** Callback when circuit closes */
  onClose?: () => void;

  /** Callback when entering half-open state */
  onHalfOpen?: () => void;

  /** Custom logger */
  logger?: Logger;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitMetrics {
  state: CircuitState;
  totalRequests: number;
  failedRequests: number;
  successfulRequests: number;
  failureRate: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
}
```

#### 3. Error Extraction

```typescript
/**
 * Extract standardized error information from HTTP client errors
 */
export function extractError(error: unknown): StandardizedError;

export interface StandardizedError {
  /** Original error object */
  originalError: unknown;

  /** Error message */
  message: string;

  /** HTTP status code (if available) */
  statusCode?: number;

  /** HTTP method */
  method?: string;

  /** Request URL */
  url?: string;

  /** Response headers */
  headers?: Record<string, string>;

  /** Response body */
  body?: any;

  /** Error classification */
  classification: ErrorClassification;

  /** Is this error retryable? */
  isRetryable: boolean;

  /** HTTP client type detected */
  clientType: 'axios' | 'fetch' | 'got' | 'node-fetch' | 'generic';

  /** Additional metadata */
  metadata?: Record<string, any>;
}

export type ErrorClassification =
  | 'network'           // Network errors (ECONNREFUSED, ETIMEDOUT, etc.)
  | 'timeout'           // Request timeout
  | 'server'            // 5xx errors
  | 'rate-limit'        // 429 Too Many Requests
  | 'client'            // 4xx errors (non-retryable)
  | 'authentication'    // 401, 403
  | 'not-found'         // 404
  | 'validation'        // 400, 422
  | 'unknown';          // Unable to classify
```

#### 4. Combined Resilient HTTP Client

```typescript
/**
 * Create a resilient HTTP client with retry and circuit breaker
 */
export function createResilientClient<T = any>(
  httpClient: HttpClient<T>,
  options?: ResilientClientOptions
): ResilientHttpClient<T>;

export interface ResilientClientOptions {
  retry?: RetryOptions;
  circuitBreaker?: CircuitBreakerOptions;
  extractError?: boolean; // Auto-extract errors (default: true)
}

export interface ResilientHttpClient<T> {
  execute(request: HttpRequest): Promise<T>;
  getCircuitState(): CircuitState;
  getMetrics(): CircuitMetrics;
}
```

---

## Core Components

### 1. Retry Orchestrator (`core/retry.ts`)

**Responsibilities:**
- Coordinate retry attempts with backoff and jitter
- Invoke timeout wrapper if configured
- Call shouldRetry predicate
- Trigger callbacks (onRetry, onFailure)
- Track attempt count and total elapsed time

**Algorithm:**
```
1. Initialize attempt counter = 0
2. Loop:
   a. Increment attempt counter
   b. Wrap function in timeout if configured
   c. Try executing function
   d. If success: return result
   e. If error:
      - Check if retryable via shouldRetry predicate
      - If not retryable: throw error
      - If max attempts reached: throw error
      - Calculate next delay using backoff + jitter
      - Call onRetry callback
      - Sleep for calculated delay
      - Continue loop
3. If all retries exhausted: call onFailure and throw
```

### 2. Circuit Breaker (`core/circuit-breaker.ts`)

**State Machine:**
```
CLOSED (normal operation)
  ↓ (failure rate > threshold)
OPEN (reject all requests)
  ↓ (after reset timeout)
HALF-OPEN (test with limited requests)
  ↓ (success threshold met)
CLOSED
```

**Responsibilities:**
- Track request success/failure in rolling window
- Calculate failure rate
- Transition between states
- Emit state change callbacks
- Provide metrics for monitoring

**State Transitions:**
- CLOSED → OPEN: When failure rate exceeds threshold
- OPEN → HALF-OPEN: After reset timeout expires
- HALF-OPEN → CLOSED: After success threshold consecutive successes
- HALF-OPEN → OPEN: On any failure

### 3. Backoff Strategies (`core/backoff.ts`)

#### Exponential Backoff
```typescript
delay = min(initialDelay * (multiplier ^ attempt), maxDelay)
```

#### Linear Backoff
```typescript
delay = min(initialDelay + (multiplier * attempt), maxDelay)
```

#### Constant Backoff
```typescript
delay = initialDelay
```

### 4. Jitter Algorithms (`core/jitter.ts`)

#### Full Jitter (Recommended - AWS best practice)
```typescript
jitteredDelay = random(0, calculatedDelay)
```

#### Equal Jitter
```typescript
jitteredDelay = calculatedDelay / 2 + random(0, calculatedDelay / 2)
```

#### Decorrelated Jitter
```typescript
jitteredDelay = random(initialDelay, previousDelay * 3)
```

**Default:** Full jitter (best decorrelation for thundering herd prevention)

### 5. Error Classifier (`error/error-classifier.ts`)

**Classification Rules:**

| Error Type | Retryable | Classification | Examples |
|------------|-----------|----------------|----------|
| Network errors | Yes | `network` | ECONNREFUSED, ENOTFOUND, ETIMEDOUT |
| 5xx errors | Yes | `server` | 500, 502, 503, 504 |
| 429 | Yes | `rate-limit` | 429 Too Many Requests |
| Timeout | Yes | `timeout` | Request timeout, socket timeout |
| 408 | Yes | `timeout` | Request Timeout |
| 4xx (except 429, 408) | No | Various | 400, 401, 403, 404, 422 |
| 401, 403 | No | `authentication` | Unauthorized, Forbidden |
| 404 | No | `not-found` | Not Found |
| 400, 422 | No | `validation` | Bad Request, Unprocessable Entity |

---

## Resilience Patterns

### Pattern 1: Simple Retry

```typescript
import { retry } from 'resilient-http';

const result = await retry(
  () => fetch('https://api.example.com/data'),
  {
    maxAttempts: 3,
    initialDelay: 1000,
    backoffStrategy: 'exponential',
    jitter: 'full'
  }
);
```

### Pattern 2: Circuit Breaker

```typescript
import { CircuitBreaker } from 'resilient-http';

const breaker = new CircuitBreaker({
  failureThreshold: 50,
  resetTimeout: 30000,
  onOpen: () => console.log('Circuit opened!'),
  onClose: () => console.log('Circuit closed!')
});

const result = await breaker.execute(
  () => fetch('https://api.example.com/data')
);
```

### Pattern 3: Combined (Retry + Circuit Breaker)

```typescript
import { retry, CircuitBreaker } from 'resilient-http';

const breaker = new CircuitBreaker();

const result = await retry(
  () => breaker.execute(() => fetch('https://api.example.com/data')),
  { maxAttempts: 3 }
);
```

### Pattern 4: Custom Retry Logic

```typescript
import { retry, extractError } from 'resilient-http';

const result = await retry(
  () => axios.get('https://api.example.com/data'),
  {
    shouldRetry: (error, attempt) => {
      const extracted = extractError(error);

      // Only retry server errors and rate limits
      return extracted.classification === 'server'
          || extracted.classification === 'rate-limit';
    },
    onRetry: (error, attempt, nextDelay) => {
      console.log(`Retry attempt ${attempt}, waiting ${nextDelay}ms`);
    }
  }
);
```

### Pattern 5: RxJS Integration

```typescript
import { retryWithBackoff } from 'resilient-http/observable';
import { from } from 'rxjs';

from(fetch('https://api.example.com/data'))
  .pipe(
    retryWithBackoff({
      maxAttempts: 3,
      initialDelay: 1000,
      jitter: 'full'
    })
  )
  .subscribe({
    next: (response) => console.log('Success:', response),
    error: (error) => console.error('Failed after retries:', error)
  });
```

---

## Error Extraction System

### Extractor Strategy Pattern

```typescript
interface ErrorExtractor {
  /** Check if this extractor can handle the error */
  canHandle(error: unknown): boolean;

  /** Extract standardized error information */
  extract(error: unknown): StandardizedError;
}
```

### Extractor Priority Chain

1. **AxiosExtractor**: Detects `error.isAxiosError === true`
2. **FetchExtractor**: Detects `error instanceof Response` or fetch-specific properties
3. **GotExtractor**: Detects `error.name === 'HTTPError'` from got library
4. **NodeFetchExtractor**: Detects node-fetch specific error structure
5. **GenericExtractor**: Fallback for unknown errors

### Auto-Detection Logic

```typescript
export function extractError(error: unknown): StandardizedError {
  const extractors = [
    new AxiosExtractor(),
    new FetchExtractor(),
    new GotExtractor(),
    new NodeFetchExtractor(),
    new GenericExtractor() // Always last (fallback)
  ];

  for (const extractor of extractors) {
    if (extractor.canHandle(error)) {
      return extractor.extract(error);
    }
  }

  // Should never reach here due to GenericExtractor
  throw new Error('No extractor found');
}
```

### Axios Error Extraction Example

```typescript
class AxiosExtractor implements ErrorExtractor {
  canHandle(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && 'isAxiosError' in error
        && error.isAxiosError === true;
  }

  extract(error: any): StandardizedError {
    const response = error.response;
    const request = error.request;
    const config = error.config;

    return {
      originalError: error,
      message: error.message,
      statusCode: response?.status,
      method: config?.method?.toUpperCase(),
      url: config?.url,
      headers: response?.headers,
      body: response?.data,
      classification: classifyError(error),
      isRetryable: isRetryable(error),
      clientType: 'axios',
      metadata: {
        code: error.code,
        timeout: config?.timeout
      }
    };
  }
}
```

---

## Build Configuration

### Package.json Configuration

```json
{
  "name": "resilient-http",
  "version": "1.0.0",
  "description": "Framework-agnostic HTTP resilience library with retry, circuit breaker, and error extraction",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "bun": "./dist/index.js"
    },
    "./core/retry": {
      "types": "./dist/core/retry.d.ts",
      "import": "./dist/core/retry.js",
      "require": "./dist/core/retry.cjs"
    },
    "./core/circuit-breaker": {
      "types": "./dist/core/circuit-breaker.d.ts",
      "import": "./dist/core/circuit-breaker.js",
      "require": "./dist/core/circuit-breaker.cjs"
    },
    "./error": {
      "types": "./dist/error/extractor.d.ts",
      "import": "./dist/error/extractor.js",
      "require": "./dist/error/extractor.cjs"
    },
    "./observable": {
      "types": "./dist/observable/index.d.ts",
      "import": "./dist/observable/index.js",
      "require": "./dist/observable/index.cjs"
    }
  },
  "files": [
    "dist",
    "README.md",
    "LICENSE"
  ],
  "sideEffects": false,
  "scripts": {
    "build": "tsup",
    "test": "bun test",
    "test:node": "node --test",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src",
    "format": "prettier --write src"
  },
  "peerDependencies": {
    "rxjs": "^7.0.0"
  },
  "peerDependenciesMeta": {
    "rxjs": {
      "optional": true
    }
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "tsup": "^8.0.0",
    "typescript": "^5.0.0",
    "bun-types": "^1.0.0",
    "rxjs": "^7.8.0",
    "axios": "^1.6.0",
    "got": "^14.0.0",
    "node-fetch": "^3.0.0"
  },
  "keywords": [
    "http",
    "retry",
    "circuit-breaker",
    "resilience",
    "error-handling",
    "backoff",
    "jitter",
    "fetch",
    "axios",
    "bun",
    "typescript"
  ],
  "engines": {
    "node": ">=18.0.0",
    "bun": ">=1.0.0"
  }
}
```

### tsup Configuration (`tsup.config.ts`)

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'core/retry': 'src/core/retry.ts',
    'core/circuit-breaker': 'src/core/circuit-breaker.ts',
    'error/extractor': 'src/error/extractor.ts',
    'observable/index': 'src/observable/index.ts'
  },
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  minify: false,
  target: 'es2020',
  outDir: 'dist',
  // Generate .d.cts for CommonJS type definitions
  dts: {
    resolve: true
  },
  external: ['rxjs'],
  noExternal: [],
  platform: 'neutral'
});
```

### TypeScript Configuration (`tsconfig.json`)

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "lib": ["ES2020"],
    "moduleResolution": "Bundler",
    "declaration": true,
    "declarationMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "types": ["node", "bun-types"],
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

### Build-specific TypeScript Config (`tsconfig.build.json`)

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "declaration": true,
    "emitDeclarationOnly": false,
    "sourceMap": true
  },
  "exclude": ["tests", "**/*.test.ts", "**/*.spec.ts"]
}
```

---

## Compatibility Matrix

| Runtime/Framework | Status | Notes |
|-------------------|--------|-------|
| **Node.js 18+** | ✅ Full | Primary target, ESM + CJS support |
| **Node.js 16** | ⚠️ Limited | ESM support, CJS fallback |
| **Bun 1.0+** | ✅ Full | Native ESM, optimized for Bun runtime |
| **Deno** | ✅ Full | ESM import from npm: specifier |
| **Browsers (Modern)** | ✅ Full | ESM bundles via bundlers (webpack, vite, rollup) |
| **Express.js** | ✅ Full | Any HTTP client (axios, got, fetch) |
| **Fastify** | ✅ Full | Any HTTP client |
| **NestJS** | ✅ Full | Works with @nestjs/axios, native fetch |
| **Next.js** | ✅ Full | Both server and client components |
| **Remix** | ✅ Full | Server and client loaders |
| **Cloudflare Workers** | ✅ Full | Fetch API support |
| **Vercel Edge** | ✅ Full | Fetch API support |

### HTTP Client Compatibility

| HTTP Client | Error Extraction | Tested |
|-------------|------------------|--------|
| **axios** | ✅ Full | Yes |
| **fetch (native)** | ✅ Full | Yes |
| **node-fetch** | ✅ Full | Yes |
| **got** | ✅ Full | Yes |
| **undici** | ✅ Full | Via fetch API |
| **superagent** | ⚠️ Generic | Fallback extractor |
| **request** | ⚠️ Generic | Deprecated, fallback extractor |

---

## Type Definitions

### Core Types (`types/config.ts`)

```typescript
export interface RetryOptions {
  maxAttempts?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffStrategy?: BackoffStrategy;
  backoffMultiplier?: number;
  jitter?: JitterStrategy;
  shouldRetry?: RetryPredicate;
  timeout?: number;
  onRetry?: RetryCallback;
  onFailure?: FailureCallback;
  logger?: Logger;
}

export type BackoffStrategy = 'exponential' | 'linear' | 'constant';
export type JitterStrategy = 'full' | 'equal' | 'decorrelated' | 'none';

export type RetryPredicate = (error: unknown, attempt: number) => boolean;
export type RetryCallback = (error: unknown, attempt: number, nextDelay: number) => void;
export type FailureCallback = (error: unknown, attempts: number) => void;

export interface Logger {
  debug(message: string, context?: any): void;
  info(message: string, context?: any): void;
  warn(message: string, context?: any): void;
  error(message: string, context?: any): void;
}
```

### Error Types (`types/error.ts`)

```typescript
export interface StandardizedError {
  originalError: unknown;
  message: string;
  statusCode?: number;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: any;
  classification: ErrorClassification;
  isRetryable: boolean;
  clientType: HttpClientType;
  metadata?: Record<string, any>;
}

export type ErrorClassification =
  | 'network'
  | 'timeout'
  | 'server'
  | 'rate-limit'
  | 'client'
  | 'authentication'
  | 'not-found'
  | 'validation'
  | 'unknown';

export type HttpClientType = 'axios' | 'fetch' | 'got' | 'node-fetch' | 'generic';
```

### HTTP Types (`types/http.ts`)

```typescript
export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  timeout?: number;
}

export interface HttpClient<T = any> {
  execute(request: HttpRequest): Promise<T>;
}
```

---

## Testing Strategy

### Unit Tests

**Coverage Targets:**
- Core retry logic: 100%
- Circuit breaker state machine: 100%
- Backoff calculations: 100%
- Jitter algorithms: 100%
- Error extractors: 100%

**Test Framework:** Bun's built-in test runner + Node.js test runner

**Key Test Cases:**

1. **Retry Logic:**
   - Successful execution on first attempt
   - Retry on transient failure
   - Max attempts exhausted
   - Non-retryable error (immediate failure)
   - Timeout handling
   - Callback invocations

2. **Circuit Breaker:**
   - State transitions (CLOSED → OPEN → HALF-OPEN → CLOSED)
   - Failure threshold calculation
   - Rolling window behavior
   - Reset timeout
   - Success threshold in half-open state
   - Metrics accuracy

3. **Backoff Strategies:**
   - Exponential backoff calculation
   - Linear backoff calculation
   - Constant backoff
   - Max delay cap enforcement

4. **Jitter:**
   - Full jitter randomness within bounds
   - Equal jitter 50/50 split
   - Decorrelated jitter range

5. **Error Extraction:**
   - Axios error extraction
   - Fetch error extraction
   - Got error extraction
   - node-fetch error extraction
   - Generic fallback
   - Error classification accuracy
   - Retryability detection

### Integration Tests

**Test Scenarios:**
1. Real HTTP requests with mock server (using MSW or nock)
2. Combined retry + circuit breaker
3. Different HTTP clients (axios, fetch, got)
4. Timeout scenarios
5. Rate limiting (429) handling

### Compatibility Tests

**Test Matrix:**
- Node.js 18, 20, 22
- Bun 1.0+
- Different bundlers (webpack, vite, rollup)
- Browser environments (Chrome, Firefox, Safari via Playwright)

---

## Performance Considerations

### Memory Footprint

**Design Goals:**
- Minimal allocations during retry loops
- Reuse timer objects
- Avoid storing large error stacks
- Circuit breaker uses fixed-size rolling window

**Optimizations:**
- Use `AbortController` for timeouts (native browser/Node.js API)
- Lazy initialization of optional features
- Tree-shaking eliminates unused code

### Bundle Size Targets

| Import | Target Size (minified + gzipped) |
|--------|----------------------------------|
| Full library | < 5KB |
| `core/retry` only | < 2KB |
| `core/circuit-breaker` only | < 2KB |
| `error/extractor` only | < 3KB |
| `observable` (with RxJS) | < 3KB (excluding RxJS) |

### Runtime Performance

**Benchmarks to Track:**
- Retry decision overhead: < 1ms
- Circuit breaker decision overhead: < 0.5ms
- Error extraction overhead: < 1ms
- Backoff calculation: < 0.1ms

**Optimization Strategies:**
- Use `performance.now()` for high-resolution timing
- Minimize function call overhead in hot paths
- Use bitwise operations where applicable
- Avoid regex in critical paths

---

## Research References

### Resilience Patterns

1. **AWS Best Practices:**
   - [Timeouts, retries and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/) - AWS Builders Library
   - [Exponential Backoff And Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/) - AWS Architecture Blog
   - [Retry with backoff pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/retry-backoff.html) - AWS Prescriptive Guidance

2. **Industry Resources:**
   - [Better Retries with Exponential Backoff and Jitter](https://www.baeldung.com/resilience4j-backoff-jitter) - Baeldung
   - [Mastering Exponential Backoff in Distributed Systems](https://betterstack.com/community/guides/monitoring/exponential-backoff/) - Better Stack Community
   - [Requests at Scale — Exponential Backoff with Jitter](https://medium.com/@titoadeoye/requests-at-scale-exponential-backoff-with-jitter-with-examples-4d0521891923) - Medium

3. **Circuit Breaker Pattern:**
   - [Resilience Patterns: Timeouts, Retries with Jitter, Circuit Breakers](https://medium.com/@mohamadshahkhajeh/resilience-patterns-in-php-timeouts-retries-with-jitter-circuit-breakers-and-bulkheads-962ebf8deed1) - Medium
   - [Downstream Resiliency: The Timeout, Retry, and Circuit-Breaker Patterns](https://medium.com/@rafaeljcamara/downstream-resiliency-the-timeout-retry-and-circuit-breaker-patterns-d8c02dc72c40) - Medium

### npm Package Best Practices

4. **Dual Module Publishing:**
   - [TypeScript in 2025 with ESM and CJS npm publishing](https://lirantal.com/blog/typescript-in-2025-with-esm-and-cjs-npm-publishing) - Liran Tal
   - [Ship ESM & CJS in one Package](https://antfu.me/posts/publish-esm-and-cjs) - Anthony Fu
   - [Writing a JavaScript Module That Works in Both CommonJS and ESM](https://armanradmanesh.com/blog/my-dual-npm-module) - Radmanesh
   - [Supporting CommonJS and ESM with Typescript and Node](https://evertpot.com/universal-commonjs-esm-typescript-packages/) - Evert Pot
   - [Tutorial: publishing ESM-based npm packages with TypeScript](https://2ality.com/2025/02/typescript-esm-packages.html) - Dr. Axel Rauschmayer

5. **Tree-Shaking:**
   - [Tree Shaking](https://webpack.js.org/guides/tree-shaking/) - webpack Documentation
   - [Everything about ESM and treeshaking](https://dev.to/pouja/everything-about-esm-and-treeshaking-5f4l) - DEV Community
   - [Tree-Shaking: A Reference Guide](https://www.smashingmagazine.com/2021/05/tree-shaking-reference-guide/) - Smashing Magazine
   - [How to bundle a tree-shakable typescript library with tsup](https://dev.to/orabazu/how-to-bundle-a-tree-shakable-typescript-library-with-tsup-and-publish-with-npm-3c46) - DEV Community

6. **Build Tools:**
   - [Dual Build Library Setup (CommonJS + ESM) Using NX](https://medium.com/@mantu.1/dual-build-library-setup-commonjs-esm-using-nx-4a928af4d698) - Medium

### Bun Compatibility

7. **Bun Runtime:**
   - Context7 Documentation: `/llmstxt/bun_sh_llms_txt`
   - Bun supports ESM and CommonJS with `require()` working in both module systems
   - Native TypeScript support allows shipping `.ts` files directly via `"bun"` export condition
   - `Bun.build()` API for bundling with ESM/CJS/IIFE formats

### TypeScript Library Configuration

8. **TypeScript Best Practices:**
   - Context7 Documentation: `/microsoft/typescript`
   - Dual package.json exports with conditional `"import"` and `"require"` paths
   - Separate type definitions for ESM (`.d.ts`) and CJS (`.d.cts`)
   - `moduleResolution: "bundler"` for modern bundler compatibility
   - Tree-shaking via `"sideEffects": false` in package.json

---

## Implementation Phases (Recommendation)

### Phase 1: Core Retry Logic (Week 1)
- Implement retry function
- Backoff strategies
- Jitter algorithms
- Basic error classification
- Unit tests

### Phase 2: Circuit Breaker (Week 2)
- Circuit breaker state machine
- Rolling window metrics
- Integration with retry
- Unit tests

### Phase 3: Error Extraction (Week 3)
- Error extractor framework
- Axios extractor
- Fetch extractor
- Got extractor
- Node-fetch extractor
- Generic fallback
- Unit tests

### Phase 4: Build & Distribution (Week 4)
- tsup configuration
- Dual module builds
- Type definition generation
- Tree-shaking verification
- Bundle size optimization

### Phase 5: RxJS Integration (Week 5)
- Retry operator
- Circuit breaker operator
- Integration tests with RxJS

### Phase 6: Documentation & Examples (Week 6)
- API documentation
- Usage guides
- Framework-specific examples
- Migration guides
- README

### Phase 7: Testing & Compatibility (Week 7)
- Integration tests
- Compatibility tests (Node, Bun, browsers)
- Performance benchmarks
- CI/CD setup

### Phase 8: Release (Week 8)
- Final testing
- Version 1.0.0 release
- npm publication
- Announcement

---

## Security Considerations

1. **No Credentials in Logs:**
   - Error extraction must sanitize sensitive headers (Authorization, Cookie, etc.)
   - Redact sensitive request/response bodies

2. **Timeout Enforcement:**
   - All retry operations must respect absolute timeout limits
   - Prevent infinite retry loops

3. **Circuit Breaker Limits:**
   - Prevent resource exhaustion via circuit breaker
   - Configurable thresholds for different risk profiles

4. **Dependency Security:**
   - Zero runtime dependencies reduces attack surface
   - Only dev dependencies for build/test

---

## Monitoring & Observability Hooks

**Optional Telemetry Integration:**

```typescript
export interface TelemetryAdapter {
  recordRetry(context: RetryContext): void;
  recordCircuitStateChange(state: CircuitState): void;
  recordError(error: StandardizedError): void;
}

export interface RetryContext {
  attempt: number;
  maxAttempts: number;
  delay: number;
  error: StandardizedError;
}
```

**Integration Examples:**
- OpenTelemetry spans for retry operations
- Prometheus metrics for circuit breaker state
- Custom logging adapters

---

## Open Questions for Implementation

1. **Should we include a default timeout for retry operations?**
   - Pro: Prevents runaway retries
   - Con: Might be too opinionated for a library

2. **Should circuit breaker state be shared across instances?**
   - Pro: Consistent behavior across multiple clients
   - Con: Requires singleton or external state management

3. **Should we provide built-in HTTP client wrappers?**
   - Pro: Easier adoption for common clients
   - Con: Increases maintenance burden

4. **Should we support custom backoff functions?**
   - Pro: Maximum flexibility
   - Con: API complexity increases

**Recommendation:** Start conservative, add features based on user feedback.

---

## Success Metrics

1. **Adoption:**
   - npm downloads > 1000/week within 3 months
   - GitHub stars > 500 within 6 months

2. **Quality:**
   - Code coverage > 95%
   - Zero critical security vulnerabilities
   - Bundle size < 5KB (gzipped)

3. **Compatibility:**
   - Works in Node.js, Bun, and browsers without issues
   - No compatibility-related bug reports

4. **Developer Experience:**
   - TypeScript types provide full IntelliSense
   - Documentation is clear and comprehensive
   - Examples cover common use cases

---

## License

MIT License - See LICENSE file for details.

---

**Document Version:** 1.0.0
**Last Updated:** 2025-12-30
**Status:** Architecture Design - Ready for Implementation Review
