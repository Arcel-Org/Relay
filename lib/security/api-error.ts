/**
 * Standardized API error handling for all route handlers.
 *
 * Usage in route handlers:
 *   import { apiError, ApiError, withErrorHandler } from '@/lib/api-error';
 *
 *   // Simple error response:
 *   return apiError('NOT_FOUND', 'User not found', 404);
 *
 *   // Throw an ApiError inside a wrapped handler:
 *   export const POST = withErrorHandler(async (request) => {
 *     if (!valid) throw new ApiError('VALIDATION_ERROR', 'Missing field', 400);
 *     return NextResponse.json({ success: true });
 *   });
 */

import { NextRequest, NextResponse } from 'next/server';
import { log } from '@/lib/platform/logger';
import { captureException } from '@/lib/platform/error-monitoring';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 500
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Return a standardized JSON error response. */
export function apiError(code: string, message: string, status: number = 500) {
  return NextResponse.json({ error: message, code }, { status });
}

// I1/D6: Global POST body size cap. 512KB is generous for all legitimate
// API payloads (largest legit body is the signup encryptedPrivateKey + PQ keys
// ~3 KB). Blocks memory-amplification attacks via huge JSON bodies.
const MAX_BODY_BYTES = 512 * 1024;

/** Thrown by capBodySize's stream when the cap is exceeded; caught below and mapped to 413. */
class BodyTooLargeError extends Error {}

/**
 * Content-Length is a client-supplied header — it can be omitted entirely
 * (chunked transfer-encoding) or simply lied about, so checking it alone
 * doesn't actually enforce anything against a client that doesn't cooperate.
 * This counts bytes as they actually arrive and aborts once MAX_BODY_BYTES
 * is exceeded regardless of what (if anything) Content-Length claimed.
 *
 * Reads the body eagerly (rather than piping a capped stream through a
 * reconstructed request, the previous approach) and overrides .text()/
 * .json()/.arrayBuffer() on the SAME request instance so every route's
 * existing request.json()/text() calls keep working with zero per-route
 * changes. Deliberately does NOT do `new NextRequest(request, {body: ...})`
 * — under some Node/undici combinations that throws "Cannot read private
 * member #state from an object whose class did not declare it" (the
 * reconstructed NextRequest's internal Request realm doesn't line up with
 * the one `request` was actually created in). Overriding methods on the
 * original instance sidesteps that entirely — it's never reconstructed.
 */
async function capBodySize(request: NextRequest): Promise<NextRequest> {
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError('Request body too large');
    }
    chunks.push(value);
  }
  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(buffer);
  Object.defineProperty(request, 'text', { value: async () => text, configurable: true });
  Object.defineProperty(request, 'json', { value: async () => JSON.parse(text), configurable: true });
  Object.defineProperty(request, 'arrayBuffer', { value: async () => buffer.buffer, configurable: true });
  return request;
}

/**
 * Wrap a route handler with consistent error handling.
 * Catches thrown ApiErrors and unexpected errors, returning a standardized response.
 * Also enforces a 512KB body size cap on POST/PUT/PATCH requests.
 */
export function withErrorHandler(
  handler: (request: NextRequest) => Promise<NextResponse>
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    try {
      let effectiveRequest = request;
      if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
        // Fast-path reject when the client sends an honest, oversized
        // Content-Length — avoids reading any of the body at all. The real
        // enforcement (below) doesn't depend on this header being present
        // or accurate.
        const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
        if (contentLength > MAX_BODY_BYTES) {
          return apiError('PAYLOAD_TOO_LARGE', 'Request body too large', 413);
        }
        effectiveRequest = await capBodySize(request);
      }
      return await handler(effectiveRequest);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return apiError('PAYLOAD_TOO_LARGE', 'Request body too large', 413);
      }
      if (err instanceof ApiError) {
        return apiError(err.code, err.message, err.status);
      }
      // Malformed / empty JSON body — request.json() throws SyntaxError
      if (err instanceof SyntaxError) {
        return apiError('VALIDATION_ERROR', 'Invalid or empty request body', 400);
      }
      log.error('Unhandled API error:', err);
      captureException(err);
      return apiError(
        'INTERNAL_ERROR',
        'An unexpected error occurred',
        500
      );
    }
  };
}
