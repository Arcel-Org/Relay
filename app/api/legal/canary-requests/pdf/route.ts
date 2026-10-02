import { NextRequest, NextResponse } from 'next/server';
import { getLegalRequestById } from '@/lib/db/canary-db';
import { readPdfBuffer } from '@/lib/legal/legal-request-files';
import { apiError, withErrorHandler } from '@/lib/security/api-error';
import { checkRateLimit } from '@/lib/security/rate-limit';

/**
 * Public: serves the redacted PDF for a published legal request, referenced
 * only by its DB id — never by the on-disk filename, which is never exposed
 * to a client (see lib/legal/legal-request-files.ts).
 */
export const GET = withErrorHandler(async (request: NextRequest) => {
  const rateLimited = checkRateLimit(request, 'public:legal-request-pdf', { maxRequests: 60, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const id = request.nextUrl.searchParams.get('id');
  if (!id) return apiError('VALIDATION_ERROR', 'Missing id', 400);

  const record = await getLegalRequestById(id);
  if (!record) return apiError('NOT_FOUND', 'No such legal request', 404);

  const buffer = await readPdfBuffer(record.pdfFilename);
  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="legal-request.pdf"',
      'Cache-Control': 'public, max-age=3600',
    },
  });
});
