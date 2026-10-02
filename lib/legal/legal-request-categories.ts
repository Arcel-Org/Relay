/**
 * Legal-process categories for the warrant-canary admin dashboard's "record a
 * legal request" form and its public display on /legal/transparency.
 *
 * Deliberately has NO dependency on lib/db/canary-db.ts (which pulls in
 * @libsql/client + fs) so client components can import this file directly
 * without bundling server-only code — see app/app/admin/canary/page.tsx.
 */
export type LegalRequestCategory =
  | 'nsl'
  | 'fisa_order'
  | 'grand_jury_subpoena'
  | 'search_warrant'
  | 'court_order'
  | 'foreign_request'
  | 'other';

export const LEGAL_REQUEST_CATEGORIES: LegalRequestCategory[] = [
  'nsl',
  'fisa_order',
  'grand_jury_subpoena',
  'search_warrant',
  'court_order',
  'foreign_request',
  'other',
];

export const LEGAL_REQUEST_CATEGORY_LABELS: Record<LegalRequestCategory, string> = {
  nsl: 'National Security Letter',
  fisa_order: 'FISA Order',
  grand_jury_subpoena: 'Grand Jury Subpoena',
  search_warrant: 'Search Warrant',
  court_order: 'Court Order (18 U.S.C. § 2703(d))',
  foreign_request: 'Foreign Government / MLAT Request',
  other: 'Other Legal Process',
};

export function isLegalRequestCategory(value: unknown): value is LegalRequestCategory {
  return typeof value === 'string' && (LEGAL_REQUEST_CATEGORIES as string[]).includes(value);
}
