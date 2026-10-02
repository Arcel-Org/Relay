/**
 * Direct coverage for lib/crypto/webauthn-client.ts — the client-side FIDO2
 * ceremony wrappers. Previously zero test coverage, unlike the server side
 * (webauthn-server.test.ts). Extra reason to cover this now: addHardwareKey
 * was just changed this session to run a step-up login ceremony BEFORE
 * registering a new credential (closing the stolen-session-cookie backdoor
 * in register-verify/route.ts) — nothing previously proved that wiring is
 * actually correct (step-up happens first, and its failure stops the flow
 * before ever reaching register-options).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
}));

import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import {
  registerHardwareKeyForSignup,
  authenticateWithHardwareKey,
  listHardwareKeys,
  addHardwareKey,
  revokeHardwareKey,
} from '../crypto/webauthn-client';

function okResponse(body: unknown) {
  return { ok: true, json: async () => body };
}
function failResponse(body: unknown = { error: 'server said no' }) {
  return { ok: false, json: async () => body };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registerHardwareKeyForSignup', () => {
  it('fetches options, runs the ceremony, verifies, and returns the ticket', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse({ options: { challenge: 'c1' } }))
      .mockResolvedValueOnce(okResponse({ ticket: 'signed-ticket' }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(startRegistration).mockResolvedValue({ id: 'cred-1' } as any);

    const ticket = await registerHardwareKeyForSignup('relay-1');

    expect(ticket).toBe('signed-ticket');
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/auth/webauthn/pre-register-options', expect.objectContaining({ method: 'POST' }));
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: 'c1' } });
    const verifyCall = fetchMock.mock.calls[1];
    expect(verifyCall[0]).toBe('/api/auth/webauthn/pre-register-verify');
    expect(JSON.parse(verifyCall[1].body)).toEqual({ relayId: 'relay-1', response: { id: 'cred-1' } });

    vi.unstubAllGlobals();
  });

  it('throws the server-provided error when fetching options fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(failResponse({ error: 'rate limited' })));
    await expect(registerHardwareKeyForSignup('relay-1')).rejects.toThrow('rate limited');
    vi.unstubAllGlobals();
  });

  it('throws a user-friendly message when the ceremony itself is cancelled/fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ options: {} })));
    vi.mocked(startRegistration).mockRejectedValue(new Error('NotAllowedError'));

    await expect(registerHardwareKeyForSignup('relay-1')).rejects.toThrow(/cancelled or failed/);
    vi.unstubAllGlobals();
  });

  it('throws the server-provided error when verification fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse({ options: {} }))
      .mockResolvedValueOnce(failResponse({ error: 'signature mismatch' }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(startRegistration).mockResolvedValue({} as any);

    await expect(registerHardwareKeyForSignup('relay-1')).rejects.toThrow('signature mismatch');
    vi.unstubAllGlobals();
  });
});

describe('authenticateWithHardwareKey', () => {
  it('fetches options and returns the completed assertion', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ options: { challenge: 'c2' } })));
    vi.mocked(startAuthentication).mockResolvedValue({ id: 'assertion-1' } as any);

    const assertion = await authenticateWithHardwareKey('relay-1');
    expect(assertion).toEqual({ id: 'assertion-1' });
    expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: 'c2' } });
    vi.unstubAllGlobals();
  });

  it('throws the server-provided error when starting login fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(failResponse({ error: 'no hardware key registered' })));
    await expect(authenticateWithHardwareKey('relay-1')).rejects.toThrow('no hardware key registered');
    vi.unstubAllGlobals();
  });

  it('throws a user-friendly message when the tap is cancelled', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ options: {} })));
    vi.mocked(startAuthentication).mockRejectedValue(new Error('NotAllowedError'));

    await expect(authenticateWithHardwareKey('relay-1')).rejects.toThrow(/cancelled or failed/);
    vi.unstubAllGlobals();
  });
});

describe('listHardwareKeys', () => {
  it('returns the parsed credential list', async () => {
    const data = { twoFactorMethod: 'webauthn' as const, credentials: [{ credentialId: 'a', createdAt: 1 }] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(data)));
    expect(await listHardwareKeys()).toEqual(data);
    vi.unstubAllGlobals();
  });

  it('throws a generic error when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(failResponse()));
    await expect(listHardwareKeys()).rejects.toThrow('Could not load hardware keys');
    vi.unstubAllGlobals();
  });
});

describe('addHardwareKey — step-up wiring', () => {
  it('runs the step-up login ceremony FIRST, then registers, and sends the assertion along with register-verify', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse({ options: { challenge: 'login-challenge' } })) // login-options (step-up)
      .mockResolvedValueOnce(okResponse({ options: { challenge: 'register-challenge' } })) // register-options
      .mockResolvedValueOnce(okResponse({ success: true })); // register-verify
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(startAuthentication).mockResolvedValue({ id: 'step-up-assertion' } as any);
    vi.mocked(startRegistration).mockResolvedValue({ id: 'new-cred' } as any);

    await addHardwareKey('relay-1');

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/auth/webauthn/login-options', expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/auth/webauthn/register-options', expect.anything());
    const verifyCall = fetchMock.mock.calls[2];
    expect(verifyCall[0]).toBe('/api/auth/webauthn/register-verify');
    expect(JSON.parse(verifyCall[1].body)).toEqual({
      response: { id: 'new-cred' },
      webauthnAssertion: { id: 'step-up-assertion' },
    });

    vi.unstubAllGlobals();
  });

  it('if the step-up ceremony fails, registration never starts (register-options is never called)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ options: {} })));
    vi.mocked(startAuthentication).mockRejectedValue(new Error('NotAllowedError'));

    await expect(addHardwareKey('relay-1')).rejects.toThrow(/cancelled or failed/);
    expect(startRegistration).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('throws the server-provided error when register-verify rejects the new credential', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okResponse({ options: {} })) // login-options
      .mockResolvedValueOnce(okResponse({ options: {} })) // register-options
      .mockResolvedValueOnce(failResponse({ error: 'invalid attestation' })); // register-verify
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(startAuthentication).mockResolvedValue({} as any);
    vi.mocked(startRegistration).mockResolvedValue({} as any);

    await expect(addHardwareKey('relay-1')).rejects.toThrow('invalid attestation');
    vi.unstubAllGlobals();
  });
});

describe('revokeHardwareKey', () => {
  it('posts the credentialId and resolves on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(revokeHardwareKey('cred-1')).resolves.toBeUndefined();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ credentialId: 'cred-1' });
    vi.unstubAllGlobals();
  });

  it('throws the server-provided error on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(failResponse({ error: 'cannot remove last key' })));
    await expect(revokeHardwareKey('cred-1')).rejects.toThrow('cannot remove last key');
    vi.unstubAllGlobals();
  });
});
