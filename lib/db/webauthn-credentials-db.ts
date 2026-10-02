/**
 * WebAuthn (FIDO2 hardware key) credential storage.
 */
import { getDb, runWriteTransaction } from './sqlite-client';
import type { Row } from '@libsql/client';

export interface WebAuthnCredential {
  credentialId: string; // base64url credential ID
  relayId: string;
  publicKeyHex: string; // hex-encoded COSE public key
  counter: number; // signature counter, used to detect cloned authenticators
  transports?: string[]; // e.g. ['usb', 'nfc', 'ble', 'internal']
  createdAt: number;
}

function rowToCredential(row: Row): WebAuthnCredential {
  return {
    credentialId: row.credentialId as string,
    relayId: row.relayId as string,
    publicKeyHex: row.publicKeyHex as string,
    counter: Number(row.counter),
    transports: row.transports ? JSON.parse(row.transports as string) : undefined,
    createdAt: Number(row.createdAt),
  };
}

export async function addCredential(cred: WebAuthnCredential): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `
      INSERT INTO webauthn_credentials (credentialId, relayId, publicKeyHex, counter, transports, createdAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    args: [
      cred.credentialId,
      cred.relayId,
      cred.publicKeyHex,
      cred.counter,
      cred.transports ? JSON.stringify(cred.transports) : null,
      cred.createdAt,
    ],
  });
}

export async function getCredentialsByRelayId(relayId: string): Promise<WebAuthnCredential[]> {
  const db = await getDb();
  const result = await db.execute({ sql: 'SELECT * FROM webauthn_credentials WHERE relayId = ?', args: [relayId] });
  return result.rows.map(rowToCredential);
}

export async function getCredentialById(credentialId: string): Promise<WebAuthnCredential | null> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT * FROM webauthn_credentials WHERE credentialId = ?',
    args: [credentialId],
  });
  return result.rows.length ? rowToCredential(result.rows[0]) : null;
}

export async function updateCredentialCounter(credentialId: string, counter: number): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: 'UPDATE webauthn_credentials SET counter = ? WHERE credentialId = ?',
    args: [counter, credentialId],
  });
}

/**
 * Atomically advance the signature counter, but only if it's still greater
 * than the currently stored value. A single UPDATE with the comparison in
 * its WHERE clause is race-free (SQLite serializes writes) — unlike a
 * separate SELECT-then-compare-then-UPDATE, which lets two concurrent
 * logins both read the old counter, both pass the clone check, and both
 * write, silently accepting a replayed/cloned assertion.
 * Returns false if another write already advanced the counter past (or to)
 * this value in the meantime, meaning the caller should treat this
 * assertion as a possible clone.
 */
export async function updateCredentialCounterIfGreater(credentialId: string, counter: number): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute({
    sql: 'UPDATE webauthn_credentials SET counter = ? WHERE credentialId = ? AND counter < ?',
    args: [counter, credentialId, counter],
  });
  return result.rowsAffected > 0;
}

export async function deleteCredential(credentialId: string): Promise<void> {
  const db = await getDb();
  await db.execute({ sql: 'DELETE FROM webauthn_credentials WHERE credentialId = ?', args: [credentialId] });
}

/**
 * Atomically check-and-delete within a single write transaction, closing the
 * TOCTOU window where two concurrent revoke requests could each observe
 * "more than one credential remains" and both delete, leaving zero.
 * When `requireAtLeastOne` is true, refuses to delete the account's last
 * remaining credential.
 */
export async function deleteCredentialIfAllowed(
  credentialId: string,
  relayId: string,
  requireAtLeastOne: boolean
): Promise<'deleted' | 'not_found' | 'last_remaining'> {
  const db = await getDb();
  return runWriteTransaction(db, async (tx) => {
    const existing = await tx.execute({
      sql: 'SELECT 1 FROM webauthn_credentials WHERE credentialId = ? AND relayId = ?',
      args: [credentialId, relayId],
    });
    if (!existing.rows.length) {
      await tx.commit();
      return 'not_found';
    }

    if (requireAtLeastOne) {
      const countResult = await tx.execute({
        sql: 'SELECT COUNT(*) as c FROM webauthn_credentials WHERE relayId = ?',
        args: [relayId],
      });
      if (Number(countResult.rows[0].c) <= 1) {
        await tx.commit();
        return 'last_remaining';
      }
    }

    await tx.execute({ sql: 'DELETE FROM webauthn_credentials WHERE credentialId = ?', args: [credentialId] });
    await tx.commit();
    return 'deleted';
  });
}
