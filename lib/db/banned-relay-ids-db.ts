/**
 * Permanent ban tombstones — see the table's comment in sqlite-client.ts.
 * Separate from the users table's row deletion: this is what actually makes
 * a ban permanent, since relayId alone (deterministic from the account's
 * public key) is otherwise trivially replayable back into existence via a
 * fresh signup request.
 */
import { getDb } from './sqlite-client';

/** Idempotent — banning an already-banned relayId is a harmless no-op. */
export async function banRelayId(relayId: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: 'INSERT INTO banned_relay_ids (relayId, bannedAt) VALUES (?, ?) ON CONFLICT(relayId) DO NOTHING',
    args: [relayId, Date.now()],
  });
}

export async function isRelayIdBanned(relayId: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT 1 FROM banned_relay_ids WHERE relayId = ? LIMIT 1',
    args: [relayId],
  });
  return result.rows.length > 0;
}
