/**
 * @vitest-environment node
 *
 * Coverage for the hand-rolled logic around the WebAuthn ceremony
 * (lib/crypto/webauthn-server.ts) that carries real security weight and has
 * no test coverage otherwise: the signed pre-registration ticket (HMAC
 * sign/verify, tamper detection, expiry, relayId binding), the per-challenge
 * store (expiry, multi-slot login challenges so two concurrent ceremonies
 * for one account don't clobber each other), the clone-detection counter
 * check, and the production env-var enforcement (getRpId/getOrigin/getSecret
 * refusing to fall back to dev defaults outside dev/test).
 *
 * The actual FIDO2 ceremony crypto (@simplewebauthn/server's attestation/
 * assertion verification) is mocked — fabricating a real authenticator
 * signature isn't practical here, and it's exercised by that library's own
 * test suite, not ours. What's under test is everything Relay wrote around it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockGenerateRegistrationOptions = vi.fn();
const mockVerifyRegistrationResponse = vi.fn();
const mockGenerateAuthenticationOptions = vi.fn();
const mockVerifyAuthenticationResponse = vi.fn();

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: (...args: unknown[]) => mockGenerateRegistrationOptions(...args),
  verifyRegistrationResponse: (...args: unknown[]) => mockVerifyRegistrationResponse(...args),
  generateAuthenticationOptions: (...args: unknown[]) => mockGenerateAuthenticationOptions(...args),
  verifyAuthenticationResponse: (...args: unknown[]) => mockVerifyAuthenticationResponse(...args),
}));

const mockGetCredentialsByRelayId = vi.fn();
const mockGetCredentialById = vi.fn();
const mockUpdateCredentialCounterIfGreater = vi.fn();
const mockAddCredential = vi.fn();

vi.mock('@/lib/db/webauthn-credentials-db', () => ({
  getCredentialsByRelayId: (...args: unknown[]) => mockGetCredentialsByRelayId(...args),
  getCredentialById: (...args: unknown[]) => mockGetCredentialById(...args),
  updateCredentialCounterIfGreater: (...args: unknown[]) => mockUpdateCredentialCounterIfGreater(...args),
  addCredential: (...args: unknown[]) => mockAddCredential(...args),
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env = { ...ORIGINAL_ENV };
  process.env.WEBAUTHN_RP_ID = 'relay.test';
  process.env.WEBAUTHN_ORIGIN = 'https://relay.test';
  process.env.SESSION_SECRET = 'a'.repeat(32);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function fakeRegistrationResult(overrides: Record<string, unknown> = {}) {
  return {
    verified: true,
    registrationInfo: {
      credential: {
        id: 'cred-id-1',
        publicKey: new Uint8Array([1, 2, 3, 4]),
        counter: 0,
        transports: ['usb'],
      },
    },
    ...overrides,
  };
}

describe('pre-registration ticket (signup flow)', () => {
  it('issues a ticket after a verified ceremony, and the ticket validates for the same relayId', async () => {
    mockGenerateRegistrationOptions.mockResolvedValue({ challenge: 'chal-1' });
    mockVerifyRegistrationResponse.mockResolvedValue(fakeRegistrationResult());
    const mod = await import('../crypto/webauthn-server');

    await mod.generatePreRegistrationOptions('alice-relay-id');
    const result = await mod.verifyPreRegistrationAndIssueTicket('alice-relay-id', {} as any);
    expect('ticket' in result).toBe(true);
    const ticket = (result as { ticket: string }).ticket;

    const data = mod.verifyRegistrationTicket(ticket, 'alice-relay-id');
    expect(data).not.toBeNull();
    expect(data?.credentialId).toBe('cred-id-1');
    expect(data?.publicKeyHex).toBe('01020304');
  });

  it('rejects a ticket presented for a different relayId than it was issued for', async () => {
    mockGenerateRegistrationOptions.mockResolvedValue({ challenge: 'chal-1' });
    mockVerifyRegistrationResponse.mockResolvedValue(fakeRegistrationResult());
    const mod = await import('../crypto/webauthn-server');

    await mod.generatePreRegistrationOptions('alice-relay-id');
    const result = await mod.verifyPreRegistrationAndIssueTicket('alice-relay-id', {} as any);
    const ticket = (result as { ticket: string }).ticket;

    expect(mod.verifyRegistrationTicket(ticket, 'mallory-relay-id')).toBeNull();
  });

  it('rejects a ticket whose payload has been tampered with (HMAC signature no longer matches)', async () => {
    mockGenerateRegistrationOptions.mockResolvedValue({ challenge: 'chal-1' });
    mockVerifyRegistrationResponse.mockResolvedValue(fakeRegistrationResult());
    const mod = await import('../crypto/webauthn-server');

    await mod.generatePreRegistrationOptions('alice-relay-id');
    const result = await mod.verifyPreRegistrationAndIssueTicket('alice-relay-id', {} as any);
    const ticket = (result as { ticket: string }).ticket;

    const [payload, sig] = ticket.split('.');
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    decoded.relayId = 'mallory-relay-id';
    const tamperedPayload = Buffer.from(JSON.stringify(decoded)).toString('base64url');
    const tamperedTicket = `${tamperedPayload}.${sig}`;

    expect(mod.verifyRegistrationTicket(tamperedTicket, 'mallory-relay-id')).toBeNull();
  });

  it('rejects an expired ticket (valid signature, but past its 15-minute lifetime)', async () => {
    mockGenerateRegistrationOptions.mockResolvedValue({ challenge: 'chal-1' });
    mockVerifyRegistrationResponse.mockResolvedValue(fakeRegistrationResult());
    const mod = await import('../crypto/webauthn-server');

    await mod.generatePreRegistrationOptions('alice-relay-id');
    const result = await mod.verifyPreRegistrationAndIssueTicket('alice-relay-id', {} as any);
    const ticket = (result as { ticket: string }).ticket;
    expect(mod.verifyRegistrationTicket(ticket, 'alice-relay-id')).not.toBeNull();

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 16 * 60 * 1000); // past TICKET_LIFETIME_MS (15 min)
      expect(mod.verifyRegistrationTicket(ticket, 'alice-relay-id')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a registration attempt with no matching stored challenge (expired or never requested)', async () => {
    const mod = await import('../crypto/webauthn-server');
    const result = await mod.verifyPreRegistrationAndIssueTicket('never-requested-relay-id', {} as any);
    expect('error' in result).toBe(true);
    expect(mockVerifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it('a challenge can only be consumed once — a second attempt after the first fails', async () => {
    mockGenerateRegistrationOptions.mockResolvedValue({ challenge: 'chal-1' });
    mockVerifyRegistrationResponse.mockResolvedValueOnce(fakeRegistrationResult());
    const mod = await import('../crypto/webauthn-server');

    await mod.generatePreRegistrationOptions('alice-relay-id');
    const first = await mod.verifyPreRegistrationAndIssueTicket('alice-relay-id', {} as any);
    expect('ticket' in first).toBe(true);

    const second = await mod.verifyPreRegistrationAndIssueTicket('alice-relay-id', {} as any);
    expect('error' in second).toBe(true);
  });

  it('surfaces the underlying verification error message when the ceremony throws', async () => {
    mockGenerateRegistrationOptions.mockResolvedValue({ challenge: 'chal-1' });
    mockVerifyRegistrationResponse.mockRejectedValue(new Error('Authenticator response challenge mismatch'));
    const mod = await import('../crypto/webauthn-server');

    await mod.generatePreRegistrationOptions('alice-relay-id');
    const result = await mod.verifyPreRegistrationAndIssueTicket('alice-relay-id', {} as any);
    expect(result).toEqual({ error: 'Authenticator response challenge mismatch' });
  });
});

describe('additional key registration (already-authenticated account)', () => {
  it('excludes the account\'s existing credentials from registration options', async () => {
    mockGetCredentialsByRelayId.mockResolvedValue([{ credentialId: 'existing-1', transports: ['usb'] }]);
    mockGenerateRegistrationOptions.mockResolvedValue({ challenge: 'chal-2' });
    const mod = await import('../crypto/webauthn-server');

    await mod.generateAdditionalKeyOptions('alice-relay-id');
    expect(mockGenerateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeCredentials: [{ id: 'existing-1', transports: ['usb'] }],
      })
    );
  });

  it('persists the credential immediately on success (no ticket indirection)', async () => {
    mockGetCredentialsByRelayId.mockResolvedValue([]);
    mockGenerateRegistrationOptions.mockResolvedValue({ challenge: 'chal-2' });
    mockVerifyRegistrationResponse.mockResolvedValue(fakeRegistrationResult());
    const mod = await import('../crypto/webauthn-server');

    await mod.generateAdditionalKeyOptions('alice-relay-id');
    const result = await mod.verifyAndStoreAdditionalKey('alice-relay-id', {} as any);

    expect(result).toEqual({ success: true });
    expect(mockAddCredential).toHaveBeenCalledWith(
      expect.objectContaining({ credentialId: 'cred-id-1', relayId: 'alice-relay-id' })
    );
  });
});

describe('login ceremony', () => {
  it('errors immediately if the account has no registered credentials', async () => {
    mockGetCredentialsByRelayId.mockResolvedValue([]);
    const mod = await import('../crypto/webauthn-server');
    const result = await mod.generateLoginOptions('alice-relay-id');
    expect(result).toEqual({ error: 'No hardware key registered for this account' });
    expect(mockGenerateAuthenticationOptions).not.toHaveBeenCalled();
  });

  it('two concurrent login-options requests for the same account both remain independently completable', async () => {
    mockGetCredentialsByRelayId.mockResolvedValue([{ credentialId: 'cred-id-1', transports: ['usb'] }]);
    mockGenerateAuthenticationOptions.mockResolvedValueOnce({ challenge: 'chal-A' }).mockResolvedValueOnce({ challenge: 'chal-B' });
    mockGetCredentialById.mockResolvedValue({
      credentialId: 'cred-id-1',
      relayId: 'alice-relay-id',
      publicKeyHex: '01020304',
      counter: 0,
    });
    mockVerifyAuthenticationResponse.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 1 } });
    mockUpdateCredentialCounterIfGreater.mockResolvedValue(true);
    const mod = await import('../crypto/webauthn-server');

    await mod.generateLoginOptions('alice-relay-id'); // tab 1 -> chal-A
    await mod.generateLoginOptions('alice-relay-id'); // tab 2 -> chal-B, must NOT evict tab 1's slot

    const clientDataA = Buffer.from(JSON.stringify({ challenge: 'chal-A' })).toString('base64url');
    const responseForTabOne = { id: 'cred-id-1', response: { clientDataJSON: clientDataA } } as any;

    // Completing the FIRST tab's ceremony (the one that would be silently
    // discarded by a single-slot challenge store) must still succeed.
    const result = await mod.verifyLoginResponse('alice-relay-id', responseForTabOne);
    expect(result).toEqual({ verified: true });
  });

  it('rejects a login attempt whose clientDataJSON is malformed', async () => {
    const mod = await import('../crypto/webauthn-server');
    const result = await mod.verifyLoginResponse('alice-relay-id', {
      id: 'cred-id-1',
      response: { clientDataJSON: 'not-valid-base64url-json!!!' },
    } as any);
    expect(result.verified).toBe(false);
  });

  it('rejects when the asserted credential belongs to a different relayId', async () => {
    mockGetCredentialsByRelayId.mockResolvedValue([{ credentialId: 'cred-id-1', transports: ['usb'] }]);
    mockGenerateAuthenticationOptions.mockResolvedValue({ challenge: 'chal-1' });
    mockGetCredentialById.mockResolvedValue({
      credentialId: 'cred-id-1',
      relayId: 'someone-else-relay-id',
      publicKeyHex: '01020304',
      counter: 0,
    });
    const mod = await import('../crypto/webauthn-server');

    await mod.generateLoginOptions('alice-relay-id');
    const clientData = Buffer.from(JSON.stringify({ challenge: 'chal-1' })).toString('base64url');
    const result = await mod.verifyLoginResponse('alice-relay-id', {
      id: 'cred-id-1',
      response: { clientDataJSON: clientData },
    } as any);
    expect(result).toEqual({ verified: false, error: 'Unknown credential' });
  });

  it('flags a possible cloned authenticator when the counter fails to strictly advance', async () => {
    mockGetCredentialsByRelayId.mockResolvedValue([{ credentialId: 'cred-id-1', transports: ['usb'] }]);
    mockGenerateAuthenticationOptions.mockResolvedValue({ challenge: 'chal-1' });
    mockGetCredentialById.mockResolvedValue({
      credentialId: 'cred-id-1',
      relayId: 'alice-relay-id',
      publicKeyHex: '01020304',
      counter: 5,
    });
    mockVerifyAuthenticationResponse.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 5 } });
    mockUpdateCredentialCounterIfGreater.mockResolvedValue(false); // simulates the racy/replayed UPDATE affecting 0 rows
    const mod = await import('../crypto/webauthn-server');

    await mod.generateLoginOptions('alice-relay-id');
    const clientData = Buffer.from(JSON.stringify({ challenge: 'chal-1' })).toString('base64url');
    const result = await mod.verifyLoginResponse('alice-relay-id', {
      id: 'cred-id-1',
      response: { clientDataJSON: clientData },
    } as any);
    expect(result).toEqual({ verified: false, error: 'Possible cloned authenticator detected (counter did not advance)' });
  });

  it('allows a counter of exactly 0 through without a clone check (authenticators without counter support)', async () => {
    mockGetCredentialsByRelayId.mockResolvedValue([{ credentialId: 'cred-id-1', transports: ['usb'] }]);
    mockGenerateAuthenticationOptions.mockResolvedValue({ challenge: 'chal-1' });
    mockGetCredentialById.mockResolvedValue({
      credentialId: 'cred-id-1',
      relayId: 'alice-relay-id',
      publicKeyHex: '01020304',
      counter: 0,
    });
    mockVerifyAuthenticationResponse.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 0 } });
    const mod = await import('../crypto/webauthn-server');

    await mod.generateLoginOptions('alice-relay-id');
    const clientData = Buffer.from(JSON.stringify({ challenge: 'chal-1' })).toString('base64url');
    const result = await mod.verifyLoginResponse('alice-relay-id', {
      id: 'cred-id-1',
      response: { clientDataJSON: clientData },
    } as any);
    expect(result).toEqual({ verified: true });
    expect(mockUpdateCredentialCounterIfGreater).not.toHaveBeenCalled();
  });
});

describe('production env-var enforcement', () => {
  it('throws instead of falling back to localhost/dev secrets when NODE_ENV=production and vars are unset', async () => {
    (process.env as { NODE_ENV: string }).NODE_ENV = 'production';
    delete process.env.WEBAUTHN_RP_ID;
    delete process.env.WEBAUTHN_ORIGIN;
    delete process.env.SESSION_SECRET;
    mockGetCredentialsByRelayId.mockResolvedValue([]);
    const mod = await import('../crypto/webauthn-server');

    await expect(mod.generatePreRegistrationOptions('alice-relay-id')).rejects.toThrow(/WEBAUTHN_RP_ID/);
  });

  it('still uses the dev/test fallbacks when NODE_ENV=test', async () => {
    delete process.env.WEBAUTHN_RP_ID;
    delete process.env.WEBAUTHN_ORIGIN;
    mockGenerateRegistrationOptions.mockResolvedValue({ challenge: 'chal-1' });
    const mod = await import('../crypto/webauthn-server');

    await expect(mod.generatePreRegistrationOptions('alice-relay-id')).resolves.toBeDefined();
    expect(mockGenerateRegistrationOptions).toHaveBeenCalledWith(expect.objectContaining({ rpID: 'localhost' }));
  });
});
