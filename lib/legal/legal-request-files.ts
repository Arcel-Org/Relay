/**
 * On-disk storage for redacted legal-process PDFs published to
 * /legal/transparency. Filenames are never client-supplied — every upload is
 * validated by its magic bytes and saved under a fresh server-generated
 * UUID, so nothing about the stored path is guessable or attacker-
 * controlled (no path traversal, no arbitrary overwrite by filename).
 * Mirrors sqlite-client.ts's DATA_DIR override pattern so tests can point
 * this at an isolated directory too.
 */
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const UPLOAD_DIR = path.join(process.env.DATA_DIR || path.join(process.cwd(), '.data'), 'canary-uploads');

const PDF_MAGIC = Buffer.from('%PDF-');

export class InvalidPdfError extends Error {
  constructor() {
    super('File is not a valid PDF');
    this.name = 'InvalidPdfError';
  }
}

/** Validates the PDF magic-byte header and writes `buffer` under a fresh UUID filename. Returns that filename (never a full path — callers never need the real disk location). */
export async function savePdfBuffer(buffer: Buffer): Promise<string> {
  if (!buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    throw new InvalidPdfError();
  }
  await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
  const filename = `${uuidv4()}.pdf`;
  await fs.promises.writeFile(path.join(UPLOAD_DIR, filename), buffer);
  return filename;
}

/** `filename` must always originate from a legal_requests DB row, never directly from client input — see this file's header. */
export async function readPdfBuffer(filename: string): Promise<Buffer> {
  return fs.promises.readFile(path.join(UPLOAD_DIR, filename));
}

export async function deletePdfFile(filename: string): Promise<void> {
  try {
    await fs.promises.unlink(path.join(UPLOAD_DIR, filename));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }
}
