export const metadata = {
  title: 'Privacy Policy — Arcel',
  description: 'How Arcel handles — and refuses to handle — your data.',
};

const EFFECTIVE_DATE = 'April 14, 2026';
const VERSION = '1.0';

const TOC = [
  ['1', 'What we do not collect', 'not-collect'],
  ['2', 'What we do collect', 'collect'],
  ['3', 'Retention at a glance', 'retention'],
  ['4', 'How your data is used', 'use'],
  ['5', 'Cookies and tracking', 'cookies'],
  ['6', 'Third parties', 'third-parties'],
  ['7', 'Law enforcement', 'law-enforcement'],
  ['8', 'International transfers', 'transfers'],
  ['9', 'Your rights', 'rights'],
  ['10', 'Security', 'security'],
  ['11', 'Children', 'children'],
  ['12', 'Changes', 'changes'],
  ['13', 'Contact', 'contact'],
];

export default function PrivacyPage() {
  return (
    <>
      <h1>Privacy Policy</h1>

      <div className="legal-meta">
        <div>Version <strong>{VERSION}</strong></div>
        <div>Effective <strong>{EFFECTIVE_DATE}</strong></div>
        <div>Supersedes <strong>none (inaugural)</strong></div>
      </div>

      <p className="lead">
        Arcel Relay is a zero-knowledge messenger. Most of this document describes what we <em>do not</em> have — because that is the honest way to frame a privacy policy for a product built around never collecting the data in the first place.
      </p>

      <div className="legal-callout">
        <div className="legal-callout-title">The one-paragraph version</div>
        <p>
          We relay ciphertext. We do not collect your email, phone, or name. We do not store message content, we do not log a record of who messaged whom, and we do not retain IP addresses on disk. Your account is a cryptographic keypair on your device — we could not decrypt your messages if a court ordered us to. The narrow, specific exceptions to &quot;we don&apos;t collect that&quot; are enumerated below, with retention windows attached to each.
        </p>
      </div>

      <div className="legal-toc">
        <div className="legal-toc-title">Contents</div>
        <ol>
          {TOC.map(([n, label, id]) => (
            <li key={id}>
              <a href={`#${id}`} data-n={n.padStart(2, '0')}>{label}</a>
            </li>
          ))}
        </ol>
      </div>

      <h2 id="not-collect">1. What we do <em>not</em> collect</h2>
      <p>
        This list is definitional — none of the following touches our infrastructure, in memory or on disk, ever. If an item moves from this list to Section 2, we will announce it in-app 30 days before the change takes effect.
      </p>
      <ul>
        <li>Your email address.</li>
        <li>Your phone number.</li>
        <li>Your real name, date of birth, or government ID.</li>
        <li>The plaintext content of your messages, voice calls, or video calls.</li>
        <li>A social graph. We do not record who you message, when, or how often.</li>
        <li>Your address book, contacts, or synced device data from iOS / Android OS integrations.</li>
        <li>Your location, beyond what is crudely implied by your IP at connection time (see Section 2.3).</li>
        <li>Your browsing history outside of Arcel.</li>
        <li>Device hardware identifiers (IMEI, MAC, advertising ID, serial numbers).</li>
        <li>Biometric data. We have no face, fingerprint, or voiceprint model.</li>
        <li>Any advertising identifiers of any kind — we do not advertise, period.</li>
      </ul>

      <h2 id="collect">2. What we do collect</h2>
      <p>
        Comprehensive list. If we collect something and it is not mentioned below, that is a privacy bug; report it to <code>privacy@arcel.org</code>.
      </p>

      <h3>2.1 Account record — persistent</h3>
      <ul>
        <li><strong>Relay ID</strong> — derived deterministically from your public key; a long, dash-separated hex string (e.g. <code>a1b2-c3d4-e5f6-a7b8-c9d0-e1f2-a3b4-c5d6</code>). You can optionally generate a short, human-shareable code (e.g. <code>xoep-4910</code>) so people can add you without typing the full ID.</li>
        <li><strong>Public key</strong> — X25519, 32 bytes, generated on your device.</li>
        <li><strong>Encrypted private key</strong> — ChaCha20-Poly1305-encrypted on your device with a key derived from your PIN plus a device fingerprint. We hold the ciphertext; we cannot decrypt it.</li>
        <li><strong>Encrypted TOTP secret</strong> and a second copy encrypted with your recovery code, for account recovery without us holding the plaintext.</li>
        <li><strong>Device fingerprint hash</strong> — a non-reversible hash used only by your device during key derivation. We do not correlate it to any hardware identifier we can query.</li>
        <li><strong>Account creation timestamp.</strong></li>
        <li><strong>Last login timestamp</strong> — overwritten, not appended. Prior values are not retained.</li>
        <li>Optional, set only if you choose to: <strong>username</strong>, <strong>display name</strong>, <strong>bio</strong>, and <strong>avatar</strong> (the avatar is selected server-side from a fixed palette at signup and is immutable). These are public to anyone who searches for you unless you mark yourself unlisted.</li>
      </ul>

      <h3>2.2 Routing state — in-memory, ≤ 20 minutes</h3>
      <ul>
        <li>The ciphertext of undelivered messages in queue. Never written to disk. Deleted upon delivery or TTL expiry, whichever comes first.</li>
        <li>Your active WebSocket connection and which Relay ID it is associated with. Cleared at disconnect.</li>
      </ul>

      <h3>2.3 Connection metadata — in-memory, ≤ 30 minutes</h3>
      <ul>
        <li>Your IP address is <strong>HMAC-SHA256-hashed with a process-lifetime salt</strong> before being used in any rate-limit or abuse-detection structure. The raw IP is not retained, not logged, and not written to disk. The salt regenerates on every restart; rate-limit state does not survive restarts.</li>
      </ul>

      <h3>2.4 Moderation records — category only, never content</h3>
      <ul>
        <li>When you submit an abuse report, only a category (spam, harassment, CSAM, or other) and the optional note you wrote are sent — never message content, which never leaves your device&apos;s decrypted state in the first place.</li>
        <li><strong>Your identity as the reporter is not recorded.</strong> There is no field, log, or database column anywhere in our system that links a report back to who filed it.</li>
        <li>Reports are kept until an operator resolves them (ban or dismiss). Resolved reports are currently kept indefinitely as an internal record of past enforcement decisions, not purged on a fixed schedule.</li>
        <li>We do not currently forward reports or any evidence to NCMEC or any other authority as a matter of routine process — we have no message content or case file to forward. See our <a href="/legal/terms#law-enforcement">Terms</a> for our obligations when compelled by valid legal process.</li>
      </ul>

      <h3>2.5 Crash reports — optional, operator-enabled only</h3>
      <ul>
        <li>If the operator running this instance has explicitly enabled it, an unexpected server-side error (a crash in the relay process or an API route) may generate a report containing the exception type, message, and stack trace, plus non-sensitive request metadata (HTTP method and URL path). This never includes cookies, request headers, request bodies, or message content — those are stripped before a report is ever sent, and this only covers our own server processes, never your browser.</li>
        <li>This is off by default. If it is enabled, the report goes to a third-party crash-reporting service (see §6).</li>
      </ul>

      <h2 id="retention">3. Retention at a glance</h2>
      <table>
        <thead>
          <tr><th>Data category</th><th>Retention</th><th>Where</th></tr>
        </thead>
        <tbody>
          <tr><td>Undelivered message ciphertext</td><td>≤ 20 minutes</td><td>Memory only</td></tr>
          <tr><td>IP address (hashed)</td><td>≤ 30 minutes</td><td>Memory only</td></tr>
          <tr><td>Account record</td><td>Until you delete the account</td><td>Disk</td></tr>
          <tr><td>Last-login timestamp</td><td>Overwritten each login</td><td>Disk</td></tr>
          <tr><td>Abuse reports (category + optional note; no reporter identity, no message content)</td><td>Indefinite (until we build a purge cycle)</td><td>Disk</td></tr>
        </tbody>
      </table>

      <h2 id="use">4. How your data is used</h2>
      <p>
        We use the data above to operate the service. Specifically:
      </p>
      <ul>
        <li>Your public key and Relay ID are how other users find you and how the relay knows where to route ciphertext.</li>
        <li>Your encrypted private key is given back to you when you sign in so you can decrypt it locally with your PIN.</li>
        <li>Your IP hash is used to rate-limit abuse (signup floods, brute-force login attempts).</li>
        <li>Your optional profile fields, if you set them, are shown to other users who search for you.</li>
      </ul>
      <p>
        We do <strong>not</strong> sell data. We do <strong>not</strong> rent it. We do <strong>not</strong> use it to build profiles, to target advertising, or to train machine-learning models. We do not generate aggregated statistics for third parties.
      </p>
      <p>
        We may use aggregate operational metrics (concurrent connections, messages relayed per hour, request latency percentiles) to understand and improve service performance. These metrics contain no personal data — they are counts, not records.
      </p>

      <h2 id="cookies">5. Cookies, tracking, and analytics</h2>
      <p>
        Arcel does not use cookies beyond a single session cookie (<code>HttpOnly</code>, <code>Secure</code>, <code>SameSite=Strict</code>) that stores an opaque session identifier. The cookie is issued only when you are logged in and is destroyed at logout.
      </p>
      <p>
        We do not use Google Analytics, Segment, Mixpanel, Amplitude, Hotjar, FullStory, or any comparable product. We embed no third-party pixels, no fonts that phone home, and no scripts we did not write. Fonts and static assets are served from our own infrastructure or a self-hosted edge cache. The network tab in your browser is the full and honest inventory of requests the product makes.
      </p>

      <h2 id="third-parties">6. Third parties who process data on our behalf</h2>
      <ul>
        <li><strong>Finland-based infrastructure provider</strong> — hosts the relay and web front end. Processes ciphertext in memory only. Contract includes no content-scanning obligations; any change to this would be announced in advance.</li>
        <li><strong>Cloudflare</strong> — edge CDN and DDoS protection. Sees your IP and the domain you request; does not see decrypted traffic (we terminate TLS at our own origin). Cloudflare&apos;s own retention is governed by its privacy policy.</li>
        <li><strong>Crash-reporting service</strong> (optional — only if the operator has enabled it) — receives only what §2.5 describes: exception details and non-sensitive request metadata from our own servers, never your device, cookies, or message content.</li>
      </ul>
      <p>
        We use no third-party customer-support SaaS, no help desk tool, and no email marketing platform. Support is handled by encrypted email to <code>support@arcel.org</code>, served by a self-hosted mail server.
      </p>

      <h2 id="law-enforcement">7. Law enforcement and legal process</h2>
      <p>
        We comply with valid legal process served on us in jurisdictions with lawful authority over us. We do not pre-emptively assist foreign or domestic law enforcement. We do not accept informal requests without legal compulsion.
      </p>
      <p>
        What we can produce, at the time we receive a lawful request, is a subset of: your Relay ID, your public key, the time of your account creation, the time of your last login (if recent), your moderation history (if any), and — for any user report filed against your Relay ID (retained indefinitely at present; see §3) — that specific report&apos;s category and note. <strong>We cannot produce message content. We cannot produce a record of who you messaged. We cannot produce your name, email, or phone.</strong>
      </p>
      <p>
        We will, where lawful, notify the affected user before or after production. We publish the number and character of legal requests received in our <a href="/legal/transparency">quarterly transparency report</a>, and we maintain a monthly-updated <a href="/legal/canary">warrant canary</a>.
      </p>

      <h2 id="transfers">8. International transfers</h2>
      <p>
        Our relay infrastructure is located in the Republic of Finland (European Union). When you connect from outside the EU, your IP and WebSocket traffic cross international borders to reach us — this is inherent to routing traffic to a server. We do not transfer personal data to processors outside the EU except as required to operate CDN services (Cloudflare, global anycast). Those transfers rely on Standard Contractual Clauses where applicable.
      </p>

      <h2 id="rights">9. Your rights</h2>
      <p>
        Depending on your jurisdiction — including the EU GDPR, UK GDPR, California CCPA/CPRA, Virginia VCDPA, Colorado CPA, and similar laws — you may have rights of access, correction, deletion, restriction, portability, and objection to processing. Because we hold so little data linked to your identity, most of these rights are trivially exercisable by you:
      </p>
      <ul>
        <li><strong>Access:</strong> your account record is visible in Settings. There is nothing else to request.</li>
        <li><strong>Deletion:</strong> clear the app&apos;s on-device storage or use &quot;Delete account&quot; in Settings. The server-side record is removed on next sync.</li>
        <li><strong>Portability:</strong> export your recovery code — it is, in effect, your key material.</li>
        <li><strong>Objection to processing:</strong> stop using the service. There is no processing to object to once you disconnect.</li>
      </ul>
      <p>
        For rights that require us to act (e.g., removing a ban record), email <code>privacy@arcel.org</code>. We verify rights requests by asking you to <strong>sign a challenge with your account keypair</strong> — we do not accept email self-identification as proof because email is not linked to your account.
      </p>
      <p>
        EU and UK users have the right to lodge a complaint with your supervisory authority. The lead supervisory authority for Arcel is the Finnish Data Protection Ombudsman (<em>tietosuoja.fi</em>).
      </p>

      <h2 id="security">10. Security</h2>
      <p>
        Arcel uses peer-reviewed cryptography: X25519 for key exchange, ChaCha20-Poly1305 for authenticated encryption, HKDF-SHA256 for key derivation, and PBKDF2-SHA256 (200,000 iterations) for PIN-based key derivation. See our <a href="/security">Security architecture</a> page for a full breakdown of what's implemented, and its honest limitations.
      </p>
      <p>
        No system is perfectly secure. If you discover a vulnerability, please disclose it responsibly to <code>security@arcel.org</code>. We do not currently run a paid bug bounty program, but we will credit responsible disclosures publicly unless you prefer anonymity.
      </p>

      <h2 id="children">11. Children</h2>
      <p>
        Arcel is not directed to children under 13. We do not knowingly collect data from children under 13. If you believe an account was created by a child under 13, report it via the in-app report flow or email <code>privacy@arcel.org</code>; the account will be terminated. We do not have the metadata necessary to age-verify independently, which is why responsibility lies with parents and the platforms distributing the Arcel client.
      </p>

      <h2 id="changes">12. Changes to this Policy</h2>
      <p>
        We revise this Policy when our practices change. Material changes are announced in-app and on our homepage at least 30 days before taking effect. We maintain a full internal version history of every revision.
      </p>

      <h2 id="contact">13. Contact</h2>
      <p>
        Privacy inquiries: <code>privacy@arcel.org</code>. General legal: <code>legal@arcel.org</code>. Security disclosures: <code>security@arcel.org</code>. Postal correspondence: Arcel Relay, care of our registered agent on file with the Wyoming Secretary of State.
      </p>
    </>
  );
}
