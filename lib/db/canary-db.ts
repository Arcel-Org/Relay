/**
 * Warrant canary confirmations + received-legal-request records.
 *
 * Two independent things live here, deliberately kept separate:
 *  - canary_confirmations: an append-only log of "an admin confirmed the six
 *    statements on /legal/canary were still true, at this exact timestamp."
 *    This module only ever appends and reads the latest row — it never
 *    rewrites the canary page's own statement text, because deciding whether
 *    those specific legal statements are still true is a human/legal
 *    judgment call this code cannot make.
 *  - legal_requests: individual legal-process records an admin has chosen to
 *    publish (redacted PDF + metadata) to /legal/transparency. Recording one
 *    of these does NOT automatically retract or edit the canary statements —
 *    an admin who receives real legal process still needs to personally
 *    re-review, and if necessary edit, the wording on the canary page before
 *    next confirming it clean. getCanaryStatus() surfaces a count of legal
 *    requests received since the last confirmation specifically so the admin
 *    dashboard can nag about exactly that.
 */
import { getDb } from './sqlite-client';
import type { Row } from '@libsql/client';
import { v4 as uuidv4 } from 'uuid';
import type { LegalRequestCategory } from '@/lib/legal/legal-request-categories';

export const CANARY_CADENCE_DAYS = 30;
const CANARY_CADENCE_MS = CANARY_CADENCE_DAYS * 24 * 60 * 60 * 1000;
// Lead time before a confirmation actually goes overdue — without this, the
// admin dashboard's alert only fires the instant it's already late, giving
// the operator zero warning to act on.
const DUE_SOON_LEAD_MS = 3 * 24 * 60 * 60 * 1000;

export interface CanaryConfirmation {
  confirmedAt: number;
  confirmedBy: string;
}

export interface CanaryStatus extends CanaryConfirmation {
  nextDueAt: number;
  overdue: boolean;
  dueSoon: boolean;
  legalRequestsSinceConfirmation: number;
}

export async function recordCanaryConfirmation(confirmedBy: string): Promise<CanaryConfirmation> {
  const db = await getDb();
  const confirmedAt = Date.now();
  await db.execute({
    sql: 'INSERT INTO canary_confirmations (confirmedAt, confirmedBy) VALUES (?, ?)',
    args: [confirmedAt, confirmedBy],
  });
  return { confirmedAt, confirmedBy };
}

export async function getLatestCanaryConfirmation(): Promise<CanaryConfirmation | null> {
  const db = await getDb();
  const result = await db.execute(
    'SELECT confirmedAt, confirmedBy FROM canary_confirmations ORDER BY confirmedAt DESC LIMIT 1'
  );
  const row = result.rows[0];
  if (!row) return null;
  return { confirmedAt: Number(row.confirmedAt), confirmedBy: row.confirmedBy as string };
}

async function countLegalRequestsSince(sinceMs: number): Promise<number> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT COUNT(*) as c FROM legal_requests WHERE receivedAt > ?',
    args: [sinceMs],
  });
  return Number(result.rows[0]?.c ?? 0);
}

/**
 * Full status the admin dashboard and the public canary page both read —
 * computed once, in one place, so "overdue" can never drift between the two.
 * Returns null only if canary_confirmations is somehow empty (shouldn't
 * happen post-migration — the migration seeds one row — but callers should
 * still handle it rather than assume).
 */
export async function getCanaryStatus(): Promise<CanaryStatus | null> {
  const latest = await getLatestCanaryConfirmation();
  if (!latest) return null;
  const nextDueAt = latest.confirmedAt + CANARY_CADENCE_MS;
  const now = Date.now();
  const legalRequestsSinceConfirmation = await countLegalRequestsSince(latest.confirmedAt);
  return {
    ...latest,
    nextDueAt,
    overdue: now > nextDueAt,
    dueSoon: now > nextDueAt - DUE_SOON_LEAD_MS,
    legalRequestsSinceConfirmation,
  };
}

export interface LegalRequestRecord {
  id: string;
  title: string;
  category: LegalRequestCategory;
  receivedAt: number;
  notes?: string;
  pdfFilename: string;
  createdBy: string;
  createdAt: number;
}

/** What's safe to hand to an unauthenticated visitor — no internal case notes, no admin identity, no raw filename (the PDF route resolves that by id itself). */
export interface PublicLegalRequest {
  id: string;
  title: string;
  category: LegalRequestCategory;
  receivedAt: number;
}

function rowToLegalRequest(row: Row): LegalRequestRecord {
  return {
    id: row.id as string,
    title: row.title as string,
    category: row.category as LegalRequestCategory,
    receivedAt: Number(row.receivedAt),
    notes: (row.notes as string) || undefined,
    pdfFilename: row.pdfFilename as string,
    createdBy: row.createdBy as string,
    createdAt: Number(row.createdAt),
  };
}

export async function insertLegalRequest(params: {
  title: string;
  category: LegalRequestCategory;
  receivedAt: number;
  notes?: string;
  pdfFilename: string;
  createdBy: string;
}): Promise<LegalRequestRecord> {
  const db = await getDb();
  const id = uuidv4();
  const createdAt = Date.now();
  await db.execute({
    sql: 'INSERT INTO legal_requests (id, title, category, receivedAt, notes, pdfFilename, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    args: [id, params.title, params.category, params.receivedAt, params.notes ?? null, params.pdfFilename, params.createdBy, createdAt],
  });
  return { id, createdAt, ...params };
}

/** Admin view — every field, every record, most recently received first. */
export async function listLegalRequests(): Promise<LegalRequestRecord[]> {
  const db = await getDb();
  const result = await db.execute('SELECT * FROM legal_requests ORDER BY receivedAt DESC');
  return result.rows.map(rowToLegalRequest);
}

/** Public view for /legal/transparency — strips notes/createdBy/pdfFilename; the PDF is served by id, never by exposing the on-disk filename. */
export async function listPublicLegalRequests(): Promise<PublicLegalRequest[]> {
  const records = await listLegalRequests();
  return records.map(({ id, title, category, receivedAt }) => ({ id, title, category, receivedAt }));
}

export async function getLegalRequestById(id: string): Promise<LegalRequestRecord | null> {
  const db = await getDb();
  const result = await db.execute({ sql: 'SELECT * FROM legal_requests WHERE id = ?', args: [id] });
  const row = result.rows[0];
  return row ? rowToLegalRequest(row) : null;
}

/** Returns the deleted record (so the caller can also remove its on-disk PDF), or null if no such id existed. */
export async function deleteLegalRequest(id: string): Promise<LegalRequestRecord | null> {
  const existing = await getLegalRequestById(id);
  if (!existing) return null;
  const db = await getDb();
  await db.execute({ sql: 'DELETE FROM legal_requests WHERE id = ?', args: [id] });
  return existing;
}
