/**
 * This is a general-purpose file-sharing app — legitimate shares include
 * .zip, .docx, .txt, .apk, and plenty of other MIME types no fixed
 * allowlist could enumerate in advance, so this is a DENYLIST of the
 * specific MIME types that execute script/markup when a browser navigates
 * to a data: URI directly (window.open, or an `<a download>` link that
 * Firefox in particular chooses to navigate rather than save). Everything
 * else — including application/octet-stream, which browsers use for any
 * type they don't recognize — is treated as inert, save-only content.
 */
const DANGEROUS_DATA_URL_MIME_RE = /^(text\/html|text\/xml|application\/xml|application\/x-mhtml|multipart\/related)$/i;

// Per RFC 7303 §4.1, a browser treats ANY MIME subtype ending in "+xml" as
// an XML document (application/rss+xml, application/atom+xml, or any
// vendor/made-up "application/x-whatever+xml") — that includes
// application/xhtml+xml and image/svg+xml specifically, but a denylist that
// only named those two (as an earlier version of this file did) missed
// every other +xml subtype, all of which can carry an
// <?xml-stylesheet type="text/xsl" ...?> processing instruction that
// transforms to HTML with an inline <script>.
const XML_SUFFIX_RE = /\+xml$/i;

const DATA_URL_RE = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,/i;

/**
 * Only `data:` URIs whose OWN declared MIME type (the part the browser
 * actually uses to decide how to render/execute the content) is NOT
 * dangerous are ever safe to assign to an href/src coming from a
 * peer-supplied file share — anything else (javascript:, vbscript:, or a
 * data: URI whose real MIME is text/html or an XML subtype smuggled behind
 * an attacker-supplied `mimeType`/filename UI label) executes in the page
 * origin when clicked/opened. Peer content is E2E-decrypted but not
 * otherwise trusted. Requires the `;base64,` form specifically — every
 * legitimate file share in this app is produced by FileReader.readAsDataURL,
 * which always emits base64; a percent-encoded data: URI is never
 * something a real client sends, so there's no reason to accept the wider
 * form here.
 */
export function isSafeDataUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = value.match(DATA_URL_RE);
  if (!match) return false;
  const mime = match[1].trim().toLowerCase();
  if (DANGEROUS_DATA_URL_MIME_RE.test(mime)) return false;
  if (XML_SUFFIX_RE.test(mime)) return false;
  if (mime.includes('javascript') || mime.includes('ecmascript') || mime.includes('vbscript')) return false;
  return true;
}

/** The MIME type actually declared inside a data: URI (not a caller-supplied label). */
export function dataUrlMimeType(value: string): string | null {
  const match = value.match(DATA_URL_RE);
  return match ? match[1].toLowerCase() : null;
}

// Unicode bidirectional embedding/override/isolate control characters —
// used for RTL-spoofing attacks (e.g. making displayed text read
// differently than its actual character sequence). Deliberately excludes
// the plain U+200E/U+200F directionality marks, which are common in
// legitimate multilingual text and don't reorder anything on their own —
// only the embedding/override/isolate controls, which do. Written as
// explicit \u{} escapes (not pasted literal characters) so the exact
// codepoints are verifiable by reading the source: U+061C (Arabic Letter
// Mark), U+202A-U+202E (LRE/RLE/PDF/LRO/RLO), U+2066-U+2069 (LRI/RLI/FSI/PDI).
const BIDI_CONTROL_CHARS_RE = /[\u061C\u202A-\u202E\u2066-\u2069]/u;

// Combining diacritical marks (the main Unicode block used by "Zalgo
// text" generators, U+0300-U+036F) stacked on a single base character —
// a handful is normal for real scripts/accents, but an unbounded run has
// no legitimate use at this length and is a rendering-griefing pattern in
// some clients/fonts. 5 in a row is already generous headroom over any
// real single-character need.
const EXCESSIVE_COMBINING_MARKS_RE = /[\u0300-\u036F]{5,}/u;

/**
 * True if `value` contains bidi-override control characters or an
 * excessive run of combining marks — reject rather than strip, since
 * silently rewriting a user's submitted text is more surprising than
 * asking them to fix it.
 */
export function hasSuspiciousTextControlChars(value: string): boolean {
  return BIDI_CONTROL_CHARS_RE.test(value) || EXCESSIVE_COMBINING_MARKS_RE.test(value);
}

const BIDI_CONTROL_CHARS_GLOBAL_RE = /[؜‪-‮⁦-⁩]/gu;
const EXCESSIVE_COMBINING_MARKS_GLOBAL_RE = /([̀-ͯ]{4})[̀-ͯ]+/gu;

/**
 * Unlike hasSuspiciousTextControlChars (used at the point a USER submits
 * their OWN profile text, where rejecting and asking them to fix it makes
 * sense), this is for content that arrives from a PEER over the E2E message
 * channel — a message, a shared file's filename, a reply preview. There's
 * no "ask them to resubmit" option for that: the content must still be
 * shown, just not in a way that lets bidi-override characters (RTLO
 * filename-extension spoofing) or Zalgo-stacked combining marks render.
 * Strips bidi control characters entirely and caps any combining-mark run
 * at 4 (matching the reject threshold in hasSuspiciousTextControlChars).
 */
export function stripSuspiciousTextControlChars(value: string): string {
  return value
    .replace(BIDI_CONTROL_CHARS_GLOBAL_RE, '')
    .replace(EXCESSIVE_COMBINING_MARKS_GLOBAL_RE, '$1');
}
