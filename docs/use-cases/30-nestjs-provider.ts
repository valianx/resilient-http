/**
 * 30-nestjs-provider.ts
 *
 * Tool: createResilientHttp inside a NestJS provider.
 * Recipe: register the resilient HTTP client via NestJS dependency injection.
 *
 * NestJS is NOT a runtime dependency of resilient-http. This file shows the
 * integration pattern without importing @nestjs/common so the use-cases
 * typecheck compiles without extra packages. Decorator syntax requires
 * experimentalDecorators which is not enabled in this tsconfig — the actual
 * class declarations are shown as doc-comments below.
 *
 * In a real NestJS application replace the pseudo-code comments with real
 * imports from '@nestjs/common' and enable experimentalDecorators in your
 * tsconfig.
 *
 * Pattern:
 *   1. Define an injection token for the client.
 *   2. Use a useFactory provider to call createResilientHttp with env-sourced config.
 *   3. Inject the client by token into services — keeps services testable by
 *      swapping the factory in tests.
 */

import { createResilientHttp } from 'resilient-http';
import type { ResilientHttpClient, ResilientHttpOptions } from 'resilient-http';

// ---------------------------------------------------------------------------
// 1. Injection token — use a Symbol to avoid name collisions.
// ---------------------------------------------------------------------------

export const RESILIENT_HTTP_CLIENT = Symbol('RESILIENT_HTTP_CLIENT');

// ---------------------------------------------------------------------------
// 2. Factory function — builds the client from environment variables.
//    Used as the `useFactory` value in the NestJS provider object.
// ---------------------------------------------------------------------------

export function createApiClient(overrides?: Partial<ResilientHttpOptions>): ResilientHttpClient {
  const baseURL = process.env['API_BASE_URL'];
  if (!baseURL) {
    throw new Error('API_BASE_URL environment variable is required');
  }

  return createResilientHttp({
    baseURL,
    timeout: 10_000,
    retry: {
      maxAttempts: 3,
      backoff:     'exponential',
      jitter:      'full',
    },
    headers: {
      'X-Service-Name': process.env['SERVICE_NAME'] ?? 'unknown',
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 3. Provider object — pass this to the `providers` array of your NestJS module.
// ---------------------------------------------------------------------------

export const resilientHttpProvider = {
  provide:    RESILIENT_HTTP_CLIENT,
  useFactory: createApiClient,
};

// ---------------------------------------------------------------------------
// 4. Usage in a service — inject the client by token.
//
// In a real NestJS application this class uses @Injectable() and @Inject():
//
//   import { Injectable, Inject } from '@nestjs/common';
//   import { RESILIENT_HTTP_CLIENT } from './http-client.provider';
//   import type { ResilientHttpClient } from 'resilient-http';
//
//   @Injectable()
//   export class UserService {
//     constructor(
//       @Inject(RESILIENT_HTTP_CLIENT)
//       private readonly http: ResilientHttpClient,
//     ) {}
//
//     async getUser(id: number) {
//       const { data } = await this.http.get<User>(`/users/${id}`);
//       return data;
//     }
//   }
//
// ---------------------------------------------------------------------------

// Plain class (no decorators) — compilable without experimentalDecorators.
interface User { id: number; name: string }

export class UserService {
  constructor(private readonly http: ResilientHttpClient) {}

  async getUser(id: number): Promise<User | null> {
    const { data } = await this.http.get<User>(`/users/${id}`);
    return data;
  }

  async createUser(payload: Omit<User, 'id'>): Promise<User | null> {
    // POST is not retried by default. Pass idempotencyKey at request level
    // if the endpoint is safe to deduplicate.
    const { data } = await this.http.post<User>('/users', { json: payload });
    return data;
  }
}

// ---------------------------------------------------------------------------
// 5. Module registration — pseudo-code shown as a doc-comment.
//
//   import { Module }                  from '@nestjs/common';
//   import { resilientHttpProvider }   from './http-client.provider';
//
//   @Module({
//     providers: [resilientHttpProvider, UserService],
//     exports:   [resilientHttpProvider],
//   })
//   export class HttpClientModule {}
//
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 6. Test-swap pattern — override the provider in a test module.
//
//   const mockFetch: typeof globalThis.fetch = async () =>
//     new Response('{"id":1,"name":"Alice"}', {
//       status: 200,
//       headers: { 'Content-Type': 'application/json' },
//     });
//
//   const testModule = await Test.createTestingModule({
//     providers: [
//       UserService,
//       {
//         provide:  RESILIENT_HTTP_CLIENT,
//         useValue: createResilientHttp({
//           baseURL: 'https://fake.local',
//           fetch:   mockFetch,
//         }),
//       },
//     ],
//   }).compile();
//
//   const service = testModule.get(UserService);
//   const user    = await service.getUser(1);
//   // user.name === 'Alice'
//
// ---------------------------------------------------------------------------

// Inline exercise: verify the factory and service work without a DI container.
export async function example30(): Promise<void> {
  const mockFetch: typeof globalThis.fetch = async () =>
    new Response('{"id":1,"name":"Alice"}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  // Simulate what NestJS does: call the factory, inject the result.
  const httpClient = createResilientHttp({
    baseURL: 'https://fake.local',
    fetch:   mockFetch,
  });

  const service = new UserService(httpClient);
  const user    = await service.getUser(1);

  console.log(user?.name); // 'Alice'
}
