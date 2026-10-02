import { getCanaryStatus } from '@/lib/db/canary-db';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Warrant Canary — Arcel',
  description: 'A statement of things that have not happened.',
};

/**
 * WARRANT CANARY.
 *
 * The six statements below are edited by hand, by a human, only once their
 * truth has actually been re-checked — this page's code never changes them
 * on its own. What IS automatic is the "last confirmed" timestamp below: an
 * authorized administrator confirms via Arcel's admin dashboard
 * (/app/admin/canary), which stamps the exact server time of confirmation
 * into the database this page reads from (lib/db/canary-db.ts). If a
 * confirmation is skipped past its due date, or any statement below
 * disappears rather than being marked retracted, users should consider the
 * possibility that the operator has received a compelled order they cannot
 * publicly discuss.
 */
function formatDateTime(ms: number): { date: string; time: string } {
  const d = new Date(ms);
  return {
    date: d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }),
    time: d.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZone: 'UTC',
      timeZoneName: 'short',
    }),
  };
}

export default async function CanaryPage() {
  const status = await getCanaryStatus();
  const confirmed = status ? formatDateTime(status.confirmedAt) : null;
  const due = status ? formatDateTime(status.nextDueAt) : null;

  return (
    <>
      <h1>Warrant canary</h1>

      <div className="legal-meta">
        <div>
          Last confirmed{' '}
          <strong>{confirmed ? `${confirmed.date} at ${confirmed.time}` : 'not yet confirmed'}</strong>
        </div>
        <div>Next check-in due <strong>{due ? due.date : '—'}</strong></div>
        <div>Cadence <strong>Every 30 days</strong></div>
      </div>

      <p className="lead">
        A warrant canary is a published statement about things that have <em>not</em> happened. If the statement disappears, or if a scheduled confirmation passes without a new one, users should infer that one of the named things <em>may</em> now have happened under a legal gag order. It is a one-way flag: we can remove it but we cannot lie in its continued publication.
      </p>

      <div className="legal-callout">
        <div className="legal-callout-title">How to read this page</div>
        <p>
          Focus on the timestamp above. If this page is not reconfirmed by the &quot;next check-in due&quot; date, assume the worst and adjust your threat model. A delayed canary is not proof of anything — infrastructure failures happen — but it is evidence that should change your behavior until we resume on-time confirmations.
        </p>
      </div>

      <h2>As of the date above, the following statements are true</h2>
      <ol>
        <li>
          Arcel has <strong>not</strong> received a National Security Letter (18 U.S.C. § 2709) or any equivalent foreign compelled-disclosure instrument accompanied by a non-disclosure requirement.
        </li>
        <li>
          Arcel has <strong>not</strong> been served with an order under the Foreign Intelligence Surveillance Act (50 U.S.C. § 1801 et seq.), including any order under Section 215 or Section 702, or a directive under any equivalent foreign statute.
        </li>
        <li>
          Arcel has <strong>not</strong> received any request, formal or informal, to deliberately weaken, backdoor, modify without audit, or otherwise compromise any cryptographic primitive, key-management system, or client build distributed under our name.
        </li>
        <li>
          Arcel has <strong>not</strong> received any request to retain data beyond the retention periods described in our <a href="/legal/privacy">Privacy Policy</a>, and has not agreed to any such retention.
        </li>
        <li>
          Arcel has <strong>not</strong> been compelled to produce private keys of any user, Relay ID, administrator, or infrastructure component.
        </li>
        <li>
          No warrant, subpoena, court order, or gag order presently in force prohibits the Operator of Arcel from making any of the statements above on this date.
        </li>
      </ol>

      <h2>How this page stays current</h2>
      <p>
        Until August 2026, updates to this page were made by hand, and each change was committed to our public source repository with a PGP signature from the canary maintainer&apos;s published key — that history remains inspectable via <code>git log --show-signature app/legal/canary/page.tsx</code> for everything up to that point.
      </p>
      <p>
        Since then, confirmations are recorded through Arcel&apos;s internal admin system: an authorized administrator reviews the six statements above and, if they are still true, confirms — which stamps the exact date and time shown above at the moment of confirmation. This is faster and harder to forget than a manual monthly commit, but we&apos;ll state plainly what it is <em>not</em>: it is not currently accompanied by a per-confirmation cryptographic signature. The guarantee now rests on our administrative access controls rather than a personal key held by one maintainer. If that changes, this section will say so.
      </p>
      <p>
        If Arcel ever receives actual legal process, a redacted copy is published, with the date it was received, on our <a href="/legal/transparency">Transparency report</a>.
      </p>

      <h2>What the absence of this statement means</h2>
      <p>
        If a scheduled confirmation passes without a new one; or if this page is removed; or if any of the specific statements is deleted rather than replaced with a &quot;no longer true&quot; acknowledgment — you should <strong>consider that statement to be at risk</strong> and act accordingly. We will not comment on why, because we may be legally unable to.
      </p>
      <p>
        The Operator retains the right to retire the canary program entirely if legal structure changes make it unnecessary. Retirement will be announced with 90 days&apos; notice.
      </p>

      <h2>Limitations — honestly stated</h2>
      <p>
        Warrant canaries are a communications tool, not a cryptographic one. Their legal durability depends on courts respecting the distinction between compelling silence and compelling affirmative speech. No U.S. court has directly ruled on whether the removal of a canary is itself a form of compelled speech that could be enjoined.
      </p>
      <p>
        This canary is published in good faith; its legal robustness has not been tested in court and should not be over-relied upon. Use it as <em>one</em> signal among several — alongside the behavior of the service, the cadence of source-code commits, the identity of the administrators, and your own operational security — rather than as a guarantee.
      </p>
    </>
  );
}
