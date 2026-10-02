/**
 * One-time migration: .data/users.json + .data/public-groups.json (old JSON
 * file store) -> .data/relay.db (libSQL/SQLite).
 *
 * Run with: npx ts-node --project tsconfig.server.json scripts/migrate-json-to-sqlite.ts
 *
 * Idempotent — safe to re-run (upserts by primary key). Old JSON files are
 * renamed to *.migrated-backup rather than deleted.
 */
import fs from 'fs/promises';
import path from 'path';
import { getDb } from '../lib/db/sqlite-client';

const DB_DIR = path.join(process.cwd(), '.data');
const USERS_JSON = path.join(DB_DIR, 'users.json');
const GROUPS_JSON = path.join(DB_DIR, 'public-groups.json');

async function readJsonIfExists(file: string): Promise<any[] | null> {
  try {
    const raw = await fs.readFile(file, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function migrateUsers(): Promise<number> {
  const users = await readJsonIfExists(USERS_JSON);
  if (!users) {
    console.log('[migrate] No users.json found, skipping.');
    return 0;
  }

  const db = await getDb();
  let migrated = 0;
  let skippedNoTotp = 0;

  for (const raw of users) {
    const relayId = raw.relayId ?? raw.polarId;
    if (!raw.id || !relayId || !raw.publicKeyHex) {
      console.warn(`[migrate] Skipping user with missing required fields: ${raw.id ?? '(no id)'}`);
      continue;
    }
    if (!raw.encryptedTOTPSecret) {
      // This column is NOT NULL. A row without it can't have logged in
      // successfully anyway (login requires it) — safe to store an empty
      // string; the account is already unusable until it re-derives TOTP.
      skippedNoTotp++;
    }

    await db.execute({
      sql: `
        INSERT INTO users (
          id, relayId, publicKeyHex, encryptedTOTPSecret, encryptedTOTPSecretForRecovery,
          createdAt, lastLogin, pqPublicKeyHex, displayName, username, bio, isUnlisted,
          recoveryCodeHash, avatarEmoji, avatarColor, failedLoginAttempts, lockedUntil
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          relayId = excluded.relayId,
          publicKeyHex = excluded.publicKeyHex,
          encryptedTOTPSecret = excluded.encryptedTOTPSecret,
          encryptedTOTPSecretForRecovery = excluded.encryptedTOTPSecretForRecovery,
          createdAt = excluded.createdAt,
          lastLogin = excluded.lastLogin,
          pqPublicKeyHex = excluded.pqPublicKeyHex,
          displayName = excluded.displayName,
          username = excluded.username,
          bio = excluded.bio,
          isUnlisted = excluded.isUnlisted,
          recoveryCodeHash = excluded.recoveryCodeHash,
          avatarEmoji = excluded.avatarEmoji,
          avatarColor = excluded.avatarColor,
          failedLoginAttempts = excluded.failedLoginAttempts,
          lockedUntil = excluded.lockedUntil
      `,
      args: [
        raw.id,
        relayId,
        raw.publicKeyHex,
        raw.encryptedTOTPSecret ?? '',
        raw.encryptedTOTPSecretForRecovery ?? '',
        raw.createdAt ?? Date.now(),
        raw.lastLogin ?? null,
        raw.pqPublicKeyHex ?? null,
        raw.displayName ?? null,
        raw.username ?? null,
        raw.bio ?? null,
        raw.isUnlisted ? 1 : null,
        raw.recoveryCodeHash ?? null,
        raw.avatarEmoji ?? null,
        raw.avatarColor ?? null,
        raw.failedLoginAttempts ?? 0,
        raw.lockedUntil ?? null,
      ],
    });
    migrated++;
  }

  if (skippedNoTotp > 0) {
    console.warn(
      `[migrate] ${skippedNoTotp} user(s) had no encryptedTOTPSecret in the source JSON.`
    );
  }
  console.warn(
    '[migrate] NOTE: TOTP secrets from the old JSON store were plaintext hex. ' +
    'They are copied as-is into the new encryptedTOTPSecret column, which the ' +
    'login route now expects to be AES-256-GCM-encrypted (see totp-server-encryption.ts). ' +
    'These migrated accounts will fail TOTP verification until they re-signup — ' +
    'same acceptable pre-production breaking change as the earlier PBKDF2 migration.'
  );
  return migrated;
}

async function migrateGroups(): Promise<number> {
  const groups = await readJsonIfExists(GROUPS_JSON);
  if (!groups) {
    console.log('[migrate] No public-groups.json found, skipping.');
    return 0;
  }

  const db = await getDb();
  let migrated = 0;
  for (const raw of groups) {
    if (!raw.groupId || !raw.publicHandle || !raw.name || !raw.ownerRelayId) {
      console.warn(`[migrate] Skipping group with missing required fields: ${raw.groupId ?? '(no id)'}`);
      continue;
    }
    await db.execute({
      sql: `
        INSERT INTO public_groups (
          groupId, publicHandle, name, description, avatarEmoji, avatarColor,
          memberCount, ownerRelayId, joinPolicy, pendingMembers, pendingRequests, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(groupId) DO UPDATE SET
          publicHandle = excluded.publicHandle,
          name = excluded.name,
          description = excluded.description,
          avatarEmoji = excluded.avatarEmoji,
          avatarColor = excluded.avatarColor,
          memberCount = excluded.memberCount,
          ownerRelayId = excluded.ownerRelayId,
          joinPolicy = excluded.joinPolicy,
          pendingMembers = excluded.pendingMembers,
          pendingRequests = excluded.pendingRequests,
          updatedAt = excluded.updatedAt
      `,
      args: [
        raw.groupId,
        raw.publicHandle,
        raw.name,
        raw.description ?? null,
        raw.avatarEmoji ?? null,
        raw.avatarColor ?? null,
        raw.memberCount ?? 1,
        raw.ownerRelayId,
        raw.joinPolicy ?? 'open',
        JSON.stringify(raw.pendingMembers ?? []),
        JSON.stringify(raw.pendingRequests ?? []),
        raw.updatedAt ?? Date.now(),
      ],
    });
    migrated++;
  }
  return migrated;
}

async function backupJsonFile(file: string): Promise<void> {
  try {
    await fs.rename(file, `${file}.migrated-backup`);
    console.log(`[migrate] Renamed ${path.basename(file)} -> ${path.basename(file)}.migrated-backup`);
  } catch {
    // File didn't exist — nothing to back up.
  }
}

async function main() {
  const userCount = await migrateUsers();
  const groupCount = await migrateGroups();
  console.log(`[migrate] Migrated ${userCount} user(s), ${groupCount} group(s) into .data/relay.db`);

  await backupJsonFile(USERS_JSON);
  await backupJsonFile(GROUPS_JSON);
  console.log('[migrate] Done.');
}

main().catch((err) => {
  console.error('[migrate] Failed:', err);
  process.exit(1);
});
