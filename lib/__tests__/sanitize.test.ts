/**
 * Coverage for lib/security/sanitize.ts — previously zero direct unit
 * tests despite being the actual XSS/spoofing defense for peer-supplied
 * file shares and text (data-URL MIME sniffing, bidi-override/Zalgo
 * stripping), used throughout the messaging layer (receive.ts,
 * use-group-messaging.ts).
 *
 * Unicode control/combining characters are built via explicit \u{} escapes
 * rather than pasted literal characters — same discipline as the source
 * file itself, so the exact codepoints under test are verifiable by
 * reading this file rather than trusting how an editor rendered them.
 */
import { describe, it, expect } from 'vitest';
import {
  isSafeDataUrl,
  dataUrlMimeType,
  hasSuspiciousTextControlChars,
  stripSuspiciousTextControlChars,
} from '../security/sanitize';

const RLO = '‮'; // right-to-left override — classic filename-extension spoofing
const LRI = '⁦';
const PDI = '⁩';
const LTR_MARK = '‎'; // plain directionality mark — must NOT be flagged
const RTL_MARK = '‏';
const COMBINING_ACUTE = '́';

describe('isSafeDataUrl', () => {
  it('accepts an ordinary base64 image data URL', () => {
    expect(isSafeDataUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(true);
  });

  it('accepts application/octet-stream (the default for unrecognized file types)', () => {
    expect(isSafeDataUrl('data:application/octet-stream;base64,AAAA')).toBe(true);
  });

  it('rejects text/html — the classic data: URI XSS vector', () => {
    expect(isSafeDataUrl('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==')).toBe(false);
  });

  it('rejects every +xml subtype, not just image/svg+xml and application/xhtml+xml', () => {
    expect(isSafeDataUrl('data:image/svg+xml;base64,AAAA')).toBe(false);
    expect(isSafeDataUrl('data:application/xhtml+xml;base64,AAAA')).toBe(false);
    expect(isSafeDataUrl('data:application/rss+xml;base64,AAAA')).toBe(false);
    expect(isSafeDataUrl('data:application/x-made-up+xml;base64,AAAA')).toBe(false);
  });

  it('rejects a mime type smuggling javascript/vbscript', () => {
    expect(isSafeDataUrl('data:application/javascript;base64,AAAA')).toBe(false);
    expect(isSafeDataUrl('data:text/vbscript;base64,AAAA')).toBe(false);
  });

  it('rejects the percent-encoded (non-base64) data: URI form', () => {
    expect(isSafeDataUrl('data:text/plain,hello%20world')).toBe(false);
  });

  it('rejects non-data: URIs and non-string values outright', () => {
    expect(isSafeDataUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeDataUrl('https://example.com/x.png')).toBe(false);
    expect(isSafeDataUrl(undefined)).toBe(false);
    expect(isSafeDataUrl(null)).toBe(false);
    expect(isSafeDataUrl(1234)).toBe(false);
  });

  it('is case-insensitive on the MIME type', () => {
    expect(isSafeDataUrl('data:TEXT/HTML;base64,AAAA')).toBe(false);
    expect(isSafeDataUrl('data:IMAGE/PNG;base64,AAAA')).toBe(true);
  });
});

describe('dataUrlMimeType', () => {
  it('extracts the declared MIME type', () => {
    expect(dataUrlMimeType('data:image/jpeg;base64,AAAA')).toBe('image/jpeg');
  });

  it('returns null for a non-data: URI', () => {
    expect(dataUrlMimeType('https://example.com/x.png')).toBeNull();
  });
});

describe('hasSuspiciousTextControlChars', () => {
  it('flags a right-to-left override character (RTLO filename-spoofing attack)', () => {
    expect(hasSuspiciousTextControlChars(`invoice${RLO}gnp.exe`)).toBe(true);
  });

  it('flags an isolate control character', () => {
    expect(hasSuspiciousTextControlChars(`hello${LRI}world${PDI}`)).toBe(true);
  });

  it('flags 5+ stacked combining marks (Zalgo text)', () => {
    expect(hasSuspiciousTextControlChars('e' + COMBINING_ACUTE.repeat(5))).toBe(true);
  });

  it('does NOT flag a handful of combining marks below the threshold', () => {
    expect(hasSuspiciousTextControlChars('e' + COMBINING_ACUTE.repeat(4))).toBe(false);
  });

  it('does NOT flag the plain LTR/RTL marks (U+200E/U+200F) — common in real multilingual text', () => {
    expect(hasSuspiciousTextControlChars(`hello${LTR_MARK}world`)).toBe(false);
    expect(hasSuspiciousTextControlChars(`hello${RTL_MARK}world`)).toBe(false);
  });

  it('does NOT flag ordinary plain text', () => {
    expect(hasSuspiciousTextControlChars('just a normal message')).toBe(false);
  });
});

describe('stripSuspiciousTextControlChars', () => {
  it('strips bidi control characters entirely', () => {
    expect(stripSuspiciousTextControlChars(`invoice${RLO}gnp.exe`)).toBe('invoicegnp.exe');
  });

  it('caps a long combining-mark run at 4 rather than stripping it entirely', () => {
    const input = 'e' + COMBINING_ACUTE.repeat(10);
    expect(stripSuspiciousTextControlChars(input)).toBe('e' + COMBINING_ACUTE.repeat(4));
  });

  it('leaves ordinary text completely unchanged', () => {
    expect(stripSuspiciousTextControlChars('cafe — hello world')).toBe('cafe — hello world');
  });

  it('leaves the plain LTR/RTL marks untouched', () => {
    expect(stripSuspiciousTextControlChars(`hello${LTR_MARK}world`)).toBe(`hello${LTR_MARK}world`);
  });
});
