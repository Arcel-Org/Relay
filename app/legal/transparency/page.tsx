import { listPublicLegalRequests } from '@/lib/db/canary-db';
import { LEGAL_REQUEST_CATEGORY_LABELS } from '@/lib/legal/legal-request-categories';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Transparency Report — Arcel',
  description: 'What we were asked for, and what we did about it.',
};

const REPORTING_PERIOD = 'Q1 2026 · January 1 – March 31, 2026';
const PUBLISHED = 'April 14, 2026';
const NEXT_REPORT = 'July 15, 2026';
const REPORT_NUMBER = 1;

export default async function TransparencyPage() {
  const legalRequests = await listPublicLegalRequests();
  return (
    <>
      <h1>Transparency report</h1>

      <div className="legal-meta">
        <div>Report <strong>#{REPORT_NUMBER}</strong></div>
        <div>Period <strong>{REPORTING_PERIOD}</strong></div>
        <div>Published <strong>{PUBLISHED}</strong></div>
        <div>Next <strong>{NEXT_REPORT}</strong></div>
      </div>

      <p className="lead">
        We publish a transparency report every quarter. This is the inaugural report. Because the service is newly launched and we retain very little data about our users, most counts are zero. We will not pretend they are impressive when they are not — but we will publish on cadence, even when the cadence is boring.
      </p>

      <div className="legal-callout">
        <div className="legal-callout-title">Commitment</div>
        <p>
          We publish this report on the same week every quarter, regardless of whether the numbers are zero or large. If a quarter&apos;s report is missed or delayed, assume something has gone wrong.
        </p>
      </div>

      <h2>1. Government and law-enforcement requests</h2>
      <table>
        <thead>
          <tr><th>Request type</th><th>Received</th><th>Produced</th></tr>
        </thead>
        <tbody>
          <tr><td>Federal criminal subpoenas (U.S.)</td><td>0</td><td>—</td></tr>
          <tr><td>State criminal subpoenas (U.S.)</td><td>0</td><td>—</td></tr>
          <tr><td>Search warrants</td><td>0</td><td>—</td></tr>
          <tr><td>Court orders (18 U.S.C. § 2703(d))</td><td>0</td><td>—</td></tr>
          <tr><td>National Security Letters</td><td>0</td><td>—</td></tr>
          <tr><td>FISA orders</td><td>0</td><td>—</td></tr>
          <tr><td>MLAT requests (foreign)</td><td>0</td><td>—</td></tr>
          <tr><td>Direct foreign requests</td><td>0</td><td>—</td></tr>
          <tr><td>Emergency disclosure requests</td><td>0</td><td>—</td></tr>
          <tr><td>Preservation requests</td><td>0</td><td>—</td></tr>
        </tbody>
      </table>
      <p>
        Where U.S. law bands the reporting of NSL and FISA requests to ranges rather than exact counts, we will comply with those banding rules and supplement with our <a href="/legal/canary">warrant canary</a>.
      </p>

      <h3>Legal requests received, in detail</h3>
      <p>
        Every legal request we receive is published here, redacted, with the date it was received — not just counted in the table above.
      </p>
      {legalRequests.length === 0 ? (
        <p>No legal process has been received to date.</p>
      ) : (
        <ul>
          {legalRequests.map((r) => (
            <li key={r.id}>
              <strong>{LEGAL_REQUEST_CATEGORY_LABELS[r.category]}</strong> — {r.title} — received{' '}
              {new Date(r.receivedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })}
              {' — '}
              <a href={`/api/legal/canary-requests/pdf?id=${r.id}`} target="_blank" rel="noopener noreferrer">
                view redacted document (PDF)
              </a>
            </li>
          ))}
        </ul>
      )}

      <h2>2. Moderation actions</h2>
      <p>
        Enforcement is binary — we dismiss a report or permanently ban the reported Relay ID. There is no suspension tier, no username-release mechanism, and no appeals process today; see our <a href="/legal/terms#moderation">Terms</a>.
      </p>
      <table>
        <thead>
          <tr><th>Action</th><th>Count</th></tr>
        </thead>
        <tbody>
          <tr><td>User reports received</td><td>0</td></tr>
          <tr><td>Reports dismissed</td><td>0</td></tr>
          <tr><td>Permanent bans</td><td>0</td></tr>
        </tbody>
      </table>

      <h2>3. Service integrity</h2>
      <table>
        <thead>
          <tr><th>Event</th><th>Count</th></tr>
        </thead>
        <tbody>
          <tr><td>Unauthorized access to infrastructure</td><td>0</td></tr>
          <tr><td>Breach of persistent store</td><td>0</td></tr>
          <tr><td>Breach of memory-resident data</td><td>0</td></tr>
          <tr><td>Credential compromise of administrators</td><td>0</td></tr>
          <tr><td>Source-code supply-chain incidents</td><td>0</td></tr>
          <tr><td>Reproducible-build verifications completed</td><td>0 (program under construction)</td></tr>
        </tbody>
      </table>

      <h2>4. Requests we refused (or would have)</h2>
      <p>
        We received zero requests in this period. Had we received any, the following categories would have been refused on the grounds stated:
      </p>
      <ul>
        <li><strong>Requests to scan user content.</strong> Refused — we do not have the technical capability and will not build it.</li>
        <li><strong>Requests to backdoor client builds.</strong> Refused.</li>
        <li><strong>Informal or voluntary requests from law enforcement without legal process.</strong> Refused.</li>
        <li><strong>Requests for data we do not hold</strong> (message content, sender-recipient graph, legal names, real-world addresses). Answered truthfully that no such data exists.</li>
      </ul>

      <h2>5. Methodology</h2>
      <p>
        Counts are derived from our internal moderation records at report-publication time. This log is not cryptographically signed today — see our <a href="/security">Security architecture</a> page for what is and isn&apos;t independently verifiable right now.
      </p>
      <p>
        Gag orders may prevent us from reporting specific request types in future periods. Where that is the case, we will publish a range (e.g., &quot;0 to 249&quot;) consistent with the U.S. Department of Justice&apos;s public reporting bands and supplement with our <a href="/legal/canary">warrant canary</a>. Any shift from exact counts to a range is itself a disclosable data point, and we will flag it.
      </p>

      <h2>6. What improves next quarter</h2>
      <p>
        These items are not commitments to specific numbers — they are commitments to the metric existing in the next report:
      </p>
      <ul>
        <li>Median time from user report to moderator decision.</li>
        <li>Uptime percentage by region, measured from edge probes.</li>
        <li>Source-repository signed-commit coverage (what percentage of production commits were signed by a published key).</li>
      </ul>

      <h2>Prior reports</h2>
      <p>
        This is the first report. Prior reports, once available, will appear below with their publication dates, report numbers, and source commit hashes for integrity verification.
      </p>
    </>
  );
}
