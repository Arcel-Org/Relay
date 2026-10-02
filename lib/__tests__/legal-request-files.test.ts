/**
 * @vitest-environment node
 *
 * Coverage for lib/legal/legal-request-files.ts against a real throwaway
 * on-disk directory (same isolation pattern as canary-db.test.ts). Covers
 * magic-byte validation (rejecting non-PDF content), the save/read/delete
 * round-trip, and that deleting twice (or a never-existing file) is a no-op
 * rather than throwing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-legal-request-files-test-'));
  process.env.DATA_DIR = tmpDir;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env.DATA_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('savePdfBuffer', () => {
  it('rejects a buffer without the %PDF- magic header', async () => {
    const { savePdfBuffer, InvalidPdfError } = await import('../legal/legal-request-files');
    await expect(savePdfBuffer(Buffer.from('not a pdf, just text'))).rejects.toThrow(InvalidPdfError);
  });

  it('saves a valid PDF buffer under a fresh generated filename, distinct per call', async () => {
    const { savePdfBuffer } = await import('../legal/legal-request-files');
    const pdfBuffer = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('fake pdf body')]);

    const filenameA = await savePdfBuffer(pdfBuffer);
    const filenameB = await savePdfBuffer(pdfBuffer);

    expect(filenameA).toMatch(/\.pdf$/);
    expect(filenameA).not.toBe(filenameB);
  });
});

describe('readPdfBuffer / deletePdfFile', () => {
  it('round-trips saved bytes back out unchanged', async () => {
    const { savePdfBuffer, readPdfBuffer } = await import('../legal/legal-request-files');
    const pdfBuffer = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('some redacted content')]);

    const filename = await savePdfBuffer(pdfBuffer);
    const readBack = await readPdfBuffer(filename);

    expect(Buffer.compare(readBack, pdfBuffer)).toBe(0);
  });

  it('deletePdfFile removes the file, and is a safe no-op if called again or on an unknown filename', async () => {
    const { savePdfBuffer, readPdfBuffer, deletePdfFile } = await import('../legal/legal-request-files');
    const pdfBuffer = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('content')]);
    const filename = await savePdfBuffer(pdfBuffer);

    await deletePdfFile(filename);
    await expect(readPdfBuffer(filename)).rejects.toThrow();

    // Deleting again, and deleting something that never existed, must not throw.
    await expect(deletePdfFile(filename)).resolves.toBeUndefined();
    await expect(deletePdfFile('never-existed.pdf')).resolves.toBeUndefined();
  });
});
