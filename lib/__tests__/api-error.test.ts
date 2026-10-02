/**
 * Direct coverage for lib/security/api-error.ts's withErrorHandler — wraps
 * essentially every API route in the app, including the 512KB global
 * body-size cap (capBodySize), which was rewritten in full this session
 * (dropped the `new NextRequest(request, {body: ...})` reconstruction that
 * crashed under some Node/undici combinations) with no test previously
 * proving the cap — or any of withErrorHandler's error-mapping paths —
 * still actually works.
 */
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ApiError, apiError, withErrorHandler } from '../security/api-error';

vi.mock('@/lib/platform/error-monitoring', () => ({ captureException: vi.fn() }));

const URL_ = 'http://localhost/api/test';
const MAX_BODY_BYTES = 512 * 1024;

function jsonRequest(method: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  return new NextRequest(URL_, {
    method,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
}

describe('withErrorHandler — body size cap', () => {
  it('passes a normal small POST body through unchanged to the handler', async () => {
    const handler = vi.fn(async (request: NextRequest) => {
      const body = await request.json();
      return apiError('OK', body.hello, 200);
    });
    const wrapped = withErrorHandler(handler);

    const res = await wrapped(jsonRequest('POST', { hello: 'world' }));
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    const data = await res.json();
    expect(data.error).toBe('world');
  });

  it('does not touch the body at all for GET requests', async () => {
    const handler = vi.fn(async () => apiError('OK', 'fine', 200));
    const wrapped = withErrorHandler(handler);

    const res = await wrapped(new NextRequest(URL_, { method: 'GET' }));
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('fast-path rejects an honest oversized Content-Length without reading the body', async () => {
    const handler = vi.fn(async () => apiError('OK', 'should not run', 200));
    const wrapped = withErrorHandler(handler);

    const res = await wrapped(
      new NextRequest(URL_, {
        method: 'POST',
        headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
        body: 'x', // body itself is tiny — only the claimed header is oversized
      })
    );

    expect(res.status).toBe(413);
    const data = await res.json();
    expect(data.code).toBe('PAYLOAD_TOO_LARGE');
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects a body that actually exceeds the cap even when Content-Length lies (or is absent)', async () => {
    const handler = vi.fn(async () => apiError('OK', 'should not run', 200));
    const wrapped = withErrorHandler(handler);

    // A real ReadableStream that yields more than MAX_BODY_BYTES total,
    // with no (accurate) Content-Length header — this is what the fast
    // path above can't catch, and what capBodySize's actual byte-counting
    // during the read has to.
    const chunk = new Uint8Array(64 * 1024).fill(65); // 64KB of 'A'
    const chunksNeeded = Math.ceil((MAX_BODY_BYTES + 1) / chunk.byteLength);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < chunksNeeded; i++) controller.enqueue(chunk);
        controller.close();
      },
    });

    const res = await wrapped(
      new NextRequest(URL_, { method: 'POST', body: stream, duplex: 'half' } as any)
    );

    expect(res.status).toBe(413);
    const data = await res.json();
    expect(data.code).toBe('PAYLOAD_TOO_LARGE');
    expect(handler).not.toHaveBeenCalled();
  });

  it('a body right at the cap boundary is accepted', async () => {
    const handler = vi.fn(async (request: NextRequest) => {
      const text = await request.text();
      return apiError('OK', String(text.length), 200);
    });
    const wrapped = withErrorHandler(handler);

    const res = await wrapped(
      new NextRequest(URL_, { method: 'POST', body: 'x'.repeat(MAX_BODY_BYTES) })
    );

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.error).toBe(String(MAX_BODY_BYTES));
  });

  it('request.json()/.text()/.arrayBuffer() all work after the cap check, not just one', async () => {
    const handler = vi.fn(async (request: NextRequest) => {
      const asText = await request.text();
      const asJson = await request.json();
      const asBuffer = await request.arrayBuffer();
      return apiError('OK', JSON.stringify({
        text: asText,
        json: asJson,
        bufferLen: asBuffer.byteLength,
      }), 200);
    });
    const wrapped = withErrorHandler(handler);

    const res = await wrapped(jsonRequest('POST', { a: 1 }));
    const data = await res.json();
    const parsed = JSON.parse(data.error);
    expect(parsed.json).toEqual({ a: 1 });
    expect(parsed.text).toBe(JSON.stringify({ a: 1 }));
    expect(parsed.bufferLen).toBe(JSON.stringify({ a: 1 }).length);
  });
});

describe('withErrorHandler — error mapping', () => {
  it('maps a thrown ApiError to its own code/message/status', async () => {
    const wrapped = withErrorHandler(async () => {
      throw new ApiError('VALIDATION_ERROR', 'bad input', 400);
    });
    const res = await wrapped(new NextRequest(URL_, { method: 'GET' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data).toEqual({ error: 'bad input', code: 'VALIDATION_ERROR' });
  });

  it('maps malformed JSON (request.json() throwing SyntaxError) to a 400 VALIDATION_ERROR', async () => {
    const wrapped = withErrorHandler(async (request: NextRequest) => {
      await request.json();
      throw new Error('unreachable');
    });
    const res = await wrapped(
      new NextRequest(URL_, { method: 'POST', body: '{not valid json' })
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe('VALIDATION_ERROR');
  });

  it('maps an unexpected thrown error to a generic 500 without leaking its message', async () => {
    const wrapped = withErrorHandler(async () => {
      throw new Error('some internal detail that should not reach the client');
    });
    const res = await wrapped(new NextRequest(URL_, { method: 'GET' }));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.code).toBe('INTERNAL_ERROR');
    expect(data.error).not.toContain('internal detail');
  });
});
