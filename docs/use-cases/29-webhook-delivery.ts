/**
 * 29-webhook-delivery.ts
 *
 * Tool: createResilientHttp + idempotencyKey + onFailure + retryableMethods.
 * Recipe: deliver a webhook event to a subscriber URL with retry and deduplication.
 *
 * Contract:
 *   - Each event has a stable eventId. Use it as the idempotency key so that
 *     retries carry the same key — a subscriber that logs or stores received IDs
 *     can detect and discard duplicates.
 *   - POST is not retried by default. Add it to retryableMethods because webhook
 *     delivery is explicitly guarded by the idempotency key.
 *   - onFailure is used to record permanent delivery failure in an audit log when
 *     all retry attempts are exhausted.
 *   - maxRetryAfter caps how long the engine will wait on a Retry-After header from
 *     the subscriber, preventing unbounded delivery delays.
 */

import { createResilientHttp, isResilientHttpError } from 'resilient-http';

// ---------------------------------------------------------------------------
// Shared event type.
// ---------------------------------------------------------------------------

interface WebhookEvent {
  eventId:   string;
  eventType: string;
  payload:   Record<string, unknown>;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Inline fetch mock — subscriber endpoint with configurable responses.
// ---------------------------------------------------------------------------

function makeSubscriberFetch(sequence: number[]): typeof globalThis.fetch {
  let i = 0;
  return async () => {
    const status = sequence[i] ?? sequence[sequence.length - 1];
    i++;
    return new Response(status < 300 ? '{"received":true}' : '{}', {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

// ---------------------------------------------------------------------------
// Webhook delivery function.
// ---------------------------------------------------------------------------

interface DeliveryResult {
  delivered: boolean;
  attempts:  number;
  error?:    string;
}

async function deliverWebhook(
  subscriberUrl: string,
  event: WebhookEvent,
  fetchImpl?: typeof globalThis.fetch,
): Promise<DeliveryResult> {
  let finalAttempts = 0;
  let failureReason = '';

  const client = createResilientHttp({
    baseURL: subscriberUrl,
    fetch:   fetchImpl,
    retry: {
      maxAttempts: 5,
      backoff:     'exponential',
      initialDelay: 500,
      maxDelay:    30_000,
      jitter:      'full',
      // POST is safe to retry here because the subscriber can deduplicate
      // via the Idempotency-Key header.
      retryableMethods: ['POST'],
      retryableStatuses: [408, 429, 500, 502, 503, 504],
      // Respect subscriber back-pressure but cap it at 30 s.
      respectRetryAfter: true,
      maxRetryAfter:     30_000,
      onFailure: (_err, attempts) => {
        finalAttempts = attempts;
        failureReason = 'all attempts exhausted';
      },
    },
    // Use the stable event ID as the idempotency key so retries are deduplicated.
    idempotencyKey: event.eventId,
    headers: {
      'Content-Type':   'application/json',
      'X-Webhook-Event': event.eventType,
    },
  });

  try {
    const { status, attempts } = await client.post('/', { json: event });
    finalAttempts = attempts;
    return { delivered: status >= 200 && status < 300, attempts };
  } catch (err) {
    if (isResilientHttpError(err)) {
      return { delivered: false, attempts: finalAttempts || err.attempts, error: failureReason };
    }
    return { delivered: false, attempts: finalAttempts, error: 'unknown error' };
  }
}

// ---------------------------------------------------------------------------
// Example A: subscriber accepts on the first try.
// ---------------------------------------------------------------------------

export async function example29a(): Promise<void> {
  const event: WebhookEvent = {
    eventId:   'evt_001',
    eventType: 'order.created',
    payload:   { orderId: 'ord_42', total: 99.99 },
    createdAt: '2026-01-01T00:00:00Z',
  };

  const result = await deliverWebhook(
    'https://subscriber.example.com',
    event,
    makeSubscriberFetch([200]),
  );

  console.log(result.delivered); // true
  console.log(result.attempts);  // 1
}

// ---------------------------------------------------------------------------
// Example B: subscriber is temporarily down — retries twice then succeeds.
// ---------------------------------------------------------------------------

export async function example29b(): Promise<void> {
  const event: WebhookEvent = {
    eventId:   'evt_002',
    eventType: 'payment.captured',
    payload:   { paymentId: 'pay_77', amount: 50 },
    createdAt: '2026-01-01T00:01:00Z',
  };

  const result = await deliverWebhook(
    'https://subscriber.example.com',
    event,
    makeSubscriberFetch([503, 503, 200]),
  );

  console.log(result.delivered); // true
  console.log(result.attempts);  // 3
}

// ---------------------------------------------------------------------------
// Example C: subscriber is permanently down — all attempts fail.
// ---------------------------------------------------------------------------

export async function example29c(): Promise<void> {
  const event: WebhookEvent = {
    eventId:   'evt_003',
    eventType: 'subscription.cancelled',
    payload:   { subscriptionId: 'sub_9' },
    createdAt: '2026-01-01T00:02:00Z',
  };

  const result = await deliverWebhook(
    'https://subscriber.example.com',
    event,
    makeSubscriberFetch([503, 503, 503, 503, 503]),
  );

  console.log(result.delivered);          // false
  console.log(result.error);              // 'all attempts exhausted'
  console.log(result.attempts >= 1);      // true
}
