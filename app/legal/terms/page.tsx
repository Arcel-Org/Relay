export const metadata = {
  title: 'Terms of Service — Arcel',
  description: 'The rules of using Arcel Relay.',
};

const EFFECTIVE_DATE = 'April 14, 2026';
const VERSION = '1.0';

const TOC = [
  ['1', 'Who we are', 'who'],
  ['2', 'What Arcel is', 'what'],
  ['3', 'Eligibility', 'eligibility'],
  ['4', 'Accounts and identity', 'accounts'],
  ['5', 'Access', 'access'],
  ['6', 'Acceptable use', 'acceptable-use'],
  ['7', 'Reporting abuse', 'reporting'],
  ['8', 'Moderation and enforcement', 'moderation'],
  ['9', 'Law enforcement', 'law-enforcement'],
  ['10', 'Service availability', 'availability'],
  ['11', 'Changes to the service', 'service-changes'],
  ['12', 'Termination', 'termination'],
  ['13', 'Disclaimers', 'disclaimers'],
  ['14', 'Limitation of liability', 'liability'],
  ['15', 'Indemnification', 'indemnification'],
  ['16', 'Governing law and disputes', 'governing-law'],
  ['17', 'DMCA', 'dmca'],
  ['18', 'Severability', 'severability'],
  ['19', 'Changes to these Terms', 'terms-changes'],
  ['20', 'Contact', 'contact'],
];

export default function TermsPage() {
  return (
    <>
      <h1>Terms of Service</h1>

      <div className="legal-meta">
        <div>Version <strong>{VERSION}</strong></div>
        <div>Effective <strong>{EFFECTIVE_DATE}</strong></div>
        <div>Supersedes <strong>none (inaugural)</strong></div>
      </div>

      <p className="lead">
        These Terms govern your use of Arcel Relay. By creating an account or sending a message through Arcel, you agree to them. If you do not agree, do not use the service.
      </p>

      <div className="legal-callout">
        <div className="legal-callout-title">The contract, in plain English</div>
        <p>
          We give you cryptographic privacy. You agree not to use that privacy to hurt other people. Specifically: no child sexual abuse material, no credible threats of violence, no non-consensual intimate imagery, no fraud that causes real harm, no attacks on the service itself. We will ban accounts that do these things, and in the case of CSAM we will refer to NCMEC. Beyond that, we stay out of your conversations.
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

      <h2 id="who">1. Who we are</h2>
      <p>
        Arcel Relay is operated by an entity formed under the laws of the State of Wyoming, United States of America (the &quot;<strong>Operator</strong>&quot;). Relay infrastructure is currently hosted in the Republic of Finland. The Operator&apos;s registered agent is listed in the Wyoming Secretary of State&apos;s public filings. Legal correspondence: <code>legal@arcel.org</code>.
      </p>

      <h2 id="what">2. What Arcel is — and isn&apos;t</h2>
      <p>
        Arcel is a <strong>relay</strong>. Your device encrypts messages using X25519 key exchange and ChaCha20-Poly1305 authenticated encryption before transmission. Our servers route the resulting ciphertext to the recipient and discard it. We do not host, back up, archive, index, scan, or analyze your messages.
      </p>
      <ul>
        <li>We cannot read your messages — there is no server-side decryption capability.</li>
        <li>We cannot recover your messages if you lose your device or recovery code.</li>
        <li>We cannot reset your PIN or restore your identity from our side.</li>
        <li>We cannot retrieve messages that have passed their 20-minute delivery window.</li>
      </ul>
      <p>
        These are features, not defects. Do not expect otherwise.
      </p>

      <h2 id="eligibility">3. Eligibility</h2>
      <p>
        You must be at least 13 years of age to use Arcel. If you are under 18 (or the age of majority where you live), you represent that you have your parent or guardian&apos;s permission. You are responsible for ensuring your use of Arcel is lawful in your jurisdiction. We make no representation that the service is lawful in every jurisdiction from which it may be accessed.
      </p>

      <h2 id="accounts">4. Accounts and cryptographic identity</h2>
      <p>
        Arcel accounts are not created with an email address, phone number, or legal name. Your account is a cryptographic keypair generated on your device, represented by a Relay ID — a long, dash-separated hex string derived from your public key. You can optionally generate a short, human-shareable code (e.g. <code>xoep-4910</code>) so people can add you without typing the full ID.
      </p>
      <p>You are solely responsible for:</p>
      <ul>
        <li>Maintaining the secrecy of your PIN, TOTP authenticator seed, and recovery code.</li>
        <li>Securing the device(s) that hold your private key.</li>
        <li>The authenticity and lawfulness of any content you send.</li>
        <li>Any actions taken under your Relay ID.</li>
      </ul>
      <p>
        <strong>Loss of credentials is irreversible.</strong> If you lose both your PIN and your recovery code, your account cannot be recovered — by us, or by anyone. We hold no copy of either.
      </p>

      <h2 id="access">5. Access</h2>
      <p>
        Creating an account is free. There is no invite code and no payment required.
      </p>

      <h2 id="acceptable-use">6. Acceptable use</h2>
      <p>You may not use Arcel to transmit, store-and-forward, or otherwise facilitate any of the following:</p>
      <ul>
        <li><strong>Child sexual abuse material (CSAM)</strong> in any form, including textual depictions, grooming communications, or links to such material. Zero tolerance. Offending accounts are permanently banned upon review.</li>
        <li><strong>Credible, specific, and imminent threats of violence</strong> against identified persons or places.</li>
        <li><strong>Coordination of terrorist attacks</strong> or other acts listed by the U.S. Department of State as terrorist activity.</li>
        <li><strong>Non-consensual intimate imagery</strong> (&quot;revenge porn&quot;).</li>
        <li><strong>Stalking, harassment, or doxxing</strong> campaigns targeting identified individuals.</li>
        <li><strong>Fraud</strong> materially harming third parties, including phishing, carding, identity theft, and investment scams.</li>
        <li><strong>Unsolicited bulk messaging</strong> (spam) and automated abuse of the relay, including attempts to exhaust server resources.</li>
        <li><strong>Attempts to circumvent, disable, or attack Arcel&apos;s security</strong>, including probing for implementation bugs in lieu of responsible disclosure, timing-analysis deanonymization attacks on other users, and attempts to impersonate other accounts.</li>
        <li><strong>Commercial bulk messaging</strong> not authorized in writing by us.</li>
        <li><strong>Use of the service in violation of applicable sanctions</strong> or export-control laws.</li>
      </ul>
      <p>
        This list is illustrative, not exhaustive. We reserve the right to suspend or terminate accounts that use Arcel to cause serious harm to others, with or without prior notice.
      </p>

      <h2 id="reporting">7. Reporting abuse</h2>
      <p>
        You can report a Relay ID for abuse from its contact profile. A report consists of a category (spam, harassment, CSAM, or other) and an optional short note you write yourself — <strong>never message content, which we have no way to access or transmit in the first place.</strong>
      </p>
      <p>
        Your own identity as the reporter is never recorded anywhere, including internally — a report cannot be traced back to who filed it, even by us. Do not submit reports falsely; knowingly false reports may factor into our enforcement decisions regarding your own account.
      </p>
      <p>
        Reports are reviewed manually. There is no fixed SLA. We deliberately do not ban an account based on report volume alone — a burst of reports can be manufactured by a single actor, so a human reviews every case before any account is banned.
      </p>

      <h2 id="moderation">8. Moderation and enforcement</h2>
      <p>
        When a report is reviewed, we may dismiss it or permanently ban the reported Relay ID. There is no suspension tier or username-release mechanism today — enforcement is binary.
      </p>
      <p>
        Resolved reports are logged internally (which Relay ID, what category, when, and the outcome), but this log is not cryptographically signed, and we do not currently forward reports or evidence to NCMEC or any other authority — we have no case file or message content to forward in the first place. We publish aggregate enforcement statistics in our quarterly <a href="/legal/transparency">transparency report</a>.
      </p>
      <p>
        Bans apply to the Relay ID (and its derivation key). They do not apply to your person or IP address. However, re-registration after a ban using a new keypair is itself a violation of these Terms and will be enforced against on discovery.
      </p>

      <h2 id="law-enforcement">9. Our obligations to law enforcement</h2>
      <p>
        We comply with valid legal process from jurisdictions with lawful authority over us. We cannot produce what we do not have. Specifically, we do not hold message content, a sender-recipient graph, phone numbers, email addresses, or legal names. IP addresses are not stored on disk and are purged from memory within 30 minutes. What we may hold is limited to the items listed in Section 2 of our <a href="/legal/privacy">Privacy Policy</a>.
      </p>
      <p>
        We publish the number and character of requests received in our <a href="/legal/transparency">transparency report</a>.
      </p>

      <h2 id="availability">10. Service availability</h2>
      <p>
        Arcel is provided on an &quot;<strong>AS IS</strong>&quot; and &quot;<strong>AS AVAILABLE</strong>&quot; basis. We do not guarantee uptime, delivery latency, or continuous availability. Scheduled maintenance and unplanned outages will occur. Where feasible, we announce them on our status page.
      </p>

      <h2 id="service-changes">11. Changes to the service</h2>
      <p>
        We may add, remove, or change features at any time. Where a change materially reduces privacy guarantees described in our Privacy Policy or these Terms, we will announce it at least 30 days in advance on our homepage and via an in-app notice.
      </p>

      <h2 id="termination">12. Termination</h2>
      <p>
        You may terminate your account at any time by deleting your identity from your device. Because we do not hold a server-side record of your identity beyond your Relay ID, public key, and encrypted credentials, this is substantively complete once your device-side data is cleared.
      </p>
      <p>
        We may terminate your access for material or repeated violation of these Terms, for legal compulsion, or for conduct that poses a serious risk to others or to the service.
      </p>

      <h2 id="disclaimers">13. Disclaimers</h2>
      <p>
        To the maximum extent permitted by law, the Operator and its officers, directors, employees, contractors, and affiliates disclaim all warranties, express or implied, including merchantability, fitness for a particular purpose, non-infringement, security, and continuous availability. No advice or information obtained from Arcel creates any warranty not expressly stated in these Terms.
      </p>

      <h2 id="liability">14. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, in no event shall the Operator be liable for indirect, incidental, special, consequential, exemplary, or punitive damages, or for any loss of profits, data, use, goodwill, or other intangibles, arising out of or in connection with Arcel, whether based in contract, tort (including negligence), or any other legal theory, even if advised of the possibility of such damages.
      </p>
      <p>
        Our aggregate liability to you for any claim arising out of Arcel shall not exceed the greater of (a) USD $5 or (b) the amount you actually paid the Operator in the twelve months preceding the event giving rise to the claim.
      </p>

      <h2 id="indemnification">15. Indemnification</h2>
      <p>
        You agree to indemnify, defend, and hold harmless the Operator and its personnel from any claim, loss, liability, or expense (including reasonable attorneys&apos; fees) arising out of or related to: (a) your violation of these Terms; (b) your violation of any third-party right; (c) content you transmit through Arcel; or (d) unlawful acts you commit using Arcel.
      </p>

      <h2 id="governing-law">16. Governing law and dispute resolution</h2>
      <p>
        These Terms are governed by the laws of the State of Wyoming, USA, without regard to its conflict-of-laws rules. Any dispute arising out of or relating to these Terms or Arcel shall be resolved by binding individual arbitration administered by the American Arbitration Association under its Consumer Arbitration Rules, in Laramie, Wyoming, or via videoconference.
      </p>
      <p>
        You and the Operator each waive the right to trial by jury and the right to participate in a class action. Either party may seek injunctive or equitable relief in a court of competent jurisdiction for infringement of intellectual property or unauthorized access to the service. Nothing in these Terms limits a consumer&apos;s right under local law to bring a small-claims action in their place of residence.
      </p>

      <h2 id="dmca">17. DMCA</h2>
      <p>
        We respect valid Digital Millennium Copyright Act (17 U.S.C. § 512) notices. Because we do not host user content, such notices will almost always be misdirected. If you believe an Arcel <em>username, profile description, or public-facing page</em> infringes your copyright, send a compliant notice to <code>dmca@arcel.org</code>. Our designated DMCA agent is registered with the U.S. Copyright Office.
      </p>

      <h2 id="severability">18. Severability and entire agreement</h2>
      <p>
        If any provision of these Terms is held invalid or unenforceable, the remaining provisions continue in full force. These Terms, together with our <a href="/legal/privacy">Privacy Policy</a>, constitute the entire agreement between you and the Operator regarding Arcel and supersede any prior agreements.
      </p>

      <h2 id="terms-changes">19. Changes to these Terms</h2>
      <p>
        We may revise these Terms. The effective date at the top of this document reflects the most recent revision. Material changes are announced in-app at least 30 days before taking effect. Your continued use of Arcel after the effective date constitutes acceptance of the revised Terms. We maintain a full internal version history of every revision.
      </p>

      <h2 id="contact">20. Contact</h2>
      <p>
        Legal: <code>legal@arcel.org</code>. Abuse reports: via the in-app Report button. DMCA: <code>dmca@arcel.org</code>. Security disclosures: <code>security@arcel.org</code>.
      </p>
    </>
  );
}
