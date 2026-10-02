/**
 * @vitest-environment node
 *
 * Real end-to-end coverage for the warrant-canary admin API routes —
 * exercises the actual exported route handlers (not just the DB/file-layer
 * functions they call) with a genuine session cookie, using the same
 * makeSessionRequest harness as admin-auth.test.ts. This is the only layer
 * that specifically covers the multipart form parsing in
 * app/api/admin/canary/legal-requests/route.ts's POST handler, which no
 * other test touches.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

let tmpDir: string;
const ADMIN_RELAY_ID = 'aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa';
const OTHER_RELAY_ID = 'bbbb-bbbb-bbbb-bbbb-bbbb-bbbb-bbbb-bbbb';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-canary-routes-test-'));
  process.env.DATA_DIR = tmpDir;
  process.env.SESSION_STORE_DIR = tmpDir;
  process.env.SESSION_SECRET = 'a'.repeat(32);
  process.env.TOTP_ENCRYPTION_KEY = '0'.repeat(64);
  process.env.ADMIN_RELAY_IDS = ADMIN_RELAY_ID;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  delete process.env.SESSION_STORE_DIR;
  delete process.env.ADMIN_RELAY_IDS;
  await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function sessionCookieFor(relayId: string): Promise<string> {
  const { saveUser } = await import('../db/relay-server-db');
  const { createSessionToken } = await import('../db/server-session');
  await saveUser({
    id: `user-${relayId}`,
    relayId,
    publicKeyHex: 'ab'.repeat(32),
    encryptedTOTPSecret: 'enc',
    encryptedTOTPSecretForRecovery: 'enc-recovery',
    createdAt: Date.now(),
    failedLoginAttempts: 0,
    twoFactorMethod: 'totp',
  });
  const token = await createSessionToken(relayId);
  return `relay_session=${token}`;
}

const FAKE_PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('redacted content here')]);

describe('canary admin routes — status and confirm', () => {
  it('GET status returns the seeded confirmation for an admin session', async () => {
    const { GET } = await import('../../app/api/admin/canary/status/route');
    const cookie = await sessionCookieFor(ADMIN_RELAY_ID);
    const req = new NextRequest('http://localhost/api/admin/canary/status', { headers: { cookie } });

    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status.confirmedBy).toBe('migration-seed');
  });

  it('GET status is forbidden for a non-admin session', async () => {
    const { GET } = await import('../../app/api/admin/canary/status/route');
    const cookie = await sessionCookieFor(OTHER_RELAY_ID);
    const req = new NextRequest('http://localhost/api/admin/canary/status', { headers: { cookie } });

    const res = await GET(req);
    expect(res.status).toBe(403);
  });

  it('POST confirm stamps the calling admin and is reflected by a subsequent GET status', async () => {
    const { POST: confirmPOST } = await import('../../app/api/admin/canary/confirm/route');
    const { GET: statusGET } = await import('../../app/api/admin/canary/status/route');
    const cookie = await sessionCookieFor(ADMIN_RELAY_ID);

    const confirmRes = await confirmPOST(new NextRequest('http://localhost/api/admin/canary/confirm', { method: 'POST', headers: { cookie } }));
    expect(confirmRes.status).toBe(200);
    const confirmData = await confirmRes.json();
    expect(confirmData.status.confirmedBy).toBe(ADMIN_RELAY_ID);
    expect(confirmData.status.overdue).toBe(false);

    const statusRes = await statusGET(new NextRequest('http://localhost/api/admin/canary/status', { headers: { cookie } }));
    const statusData = await statusRes.json();
    expect(statusData.status.confirmedBy).toBe(ADMIN_RELAY_ID);
    expect(statusData.status.confirmedAt).toBe(confirmData.status.confirmedAt);
  });
});

describe('canary admin routes — legal requests (multipart upload)', () => {
  it('records a legal request from real multipart form data, lists it, serves its PDF, then deletes it', async () => {
    const { POST: createPOST, GET: listGET, DELETE: deleteRoute } = await import('../../app/api/admin/canary/legal-requests/route');
    const { GET: pdfGET } = await import('../../app/api/legal/canary-requests/pdf/route');
    const { getLegalRequestById } = await import('../db/canary-db');
    const cookie = await sessionCookieFor(ADMIN_RELAY_ID);

    const form = new FormData();
    form.set('title', 'Grand jury subpoena — test district');
    form.set('category', 'grand_jury_subpoena');
    form.set('receivedAt', '2026-07-20');
    form.set('notes', 'internal note');
    form.set('pdf', new File([FAKE_PDF], 'subpoena.pdf', { type: 'application/pdf' }));

    const createRes = await createPOST(new NextRequest('http://localhost/api/admin/canary/legal-requests', {
      method: 'POST',
      headers: { cookie },
      body: form,
    }));
    expect(createRes.status).toBe(200);
    const createData = await createRes.json();
    expect(createData.success).toBe(true);
    const id = createData.request.id as string;
    expect(createData.request.title).toBe('Grand jury subpoena — test district');

    // Listed in the admin view.
    const listRes = await listGET(new NextRequest('http://localhost/api/admin/canary/legal-requests', { headers: { cookie } }));
    const listData = await listRes.json();
    expect(listData.requests.some((r: { id: string }) => r.id === id)).toBe(true);

    // Publicly servable by id, with the actual uploaded bytes.
    const pdfRes = await pdfGET(new NextRequest(`http://localhost/api/legal/canary-requests/pdf?id=${id}`));
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers.get('content-type')).toBe('application/pdf');
    const servedBytes = Buffer.from(await pdfRes.arrayBuffer());
    expect(Buffer.compare(servedBytes, FAKE_PDF)).toBe(0);

    // Deletable, and gone afterward — both from the DB and the filesystem.
    const deleteRes = await deleteRoute(new NextRequest(`http://localhost/api/admin/canary/legal-requests?id=${id}`, {
      method: 'DELETE',
      headers: { cookie },
    }));
    expect(deleteRes.status).toBe(200);
    expect(await getLegalRequestById(id)).toBeNull();
    const pdfAfterDeleteRes = await pdfGET(new NextRequest(`http://localhost/api/legal/canary-requests/pdf?id=${id}`));
    expect(pdfAfterDeleteRes.status).toBe(404);
  });

  it('rejects a non-PDF upload with 400 rather than silently storing it', async () => {
    const { POST: createPOST } = await import('../../app/api/admin/canary/legal-requests/route');
    const cookie = await sessionCookieFor(ADMIN_RELAY_ID);

    const form = new FormData();
    form.set('title', 'Bad upload');
    form.set('category', 'other');
    form.set('receivedAt', '2026-07-20');
    form.set('pdf', new File([Buffer.from('not a pdf')], 'fake.pdf', { type: 'application/pdf' }));

    const res = await createPOST(new NextRequest('http://localhost/api/admin/canary/legal-requests', {
      method: 'POST',
      headers: { cookie },
      body: form,
    }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe('VALIDATION_ERROR');
  });
});
