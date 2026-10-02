import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/security/admin-auth';
import { insertLegalRequest, listLegalRequests, deleteLegalRequest } from '@/lib/db/canary-db';
import { isLegalRequestCategory } from '@/lib/legal/legal-request-categories';
import { savePdfBuffer, deletePdfFile, InvalidPdfError } from '@/lib/legal/legal-request-files';
import { ApiError, apiError, withErrorHandler } from '@/lib/security/api-error';
import { checkRateLimit } from '@/lib/security/rate-limit';
import { log } from '@/lib/platform/logger';
import { captureException } from '@/lib/platform/error-monitoring';

const MAX_PDF_BYTES = 20 * 1024 * 1024; // 20MB — generous for a redacted legal document, small enough to bound memory use.

/** Operator-only: every legal-request record on file (full fields, unlike the public view). */
export const GET = withErrorHandler(async (request: NextRequest) => {
  const rateLimited = checkRateLimit(request, 'admin:canary-legal-requests-list', { maxRequests: 30, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;

  const requests = await listLegalRequests();
  return NextResponse.json({ requests }, { status: 200 });
});

/**
 * Operator-only: record a legal request received, with its redacted PDF.
 * Multipart form data (title, category, receivedAt, notes?, pdf file) — NOT
 * wrapped in withErrorHandler, since that helper's 512KB body cap (sized for
 * ordinary JSON payloads) would reject any real PDF. Rate limiting and the
 * admin check still run first, before the multipart body is ever parsed, so
 * an unauthenticated caller can't force this route to do expensive work.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const rateLimited = checkRateLimit(request, 'admin:canary-legal-request-create', { maxRequests: 10, windowMs: 60_000 });
    if (rateLimited) return rateLimited;

    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;

    const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_PDF_BYTES) {
      return apiError('PAYLOAD_TOO_LARGE', 'PDF exceeds the 20MB limit', 413);
    }

    const form = await request.formData();
    const title = typeof form.get('title') === 'string' ? (form.get('title') as string).trim() : '';
    const category = form.get('category');
    const receivedAtRaw = form.get('receivedAt');
    const notesRaw = form.get('notes');
    const file = form.get('pdf');

    if (!title) return apiError('VALIDATION_ERROR', 'Title is required', 400);
    if (!isLegalRequestCategory(category)) return apiError('VALIDATION_ERROR', 'Invalid category', 400);
    const receivedAt = typeof receivedAtRaw === 'string' ? Date.parse(receivedAtRaw) : NaN;
    if (!Number.isFinite(receivedAt)) return apiError('VALIDATION_ERROR', 'Invalid receivedAt date', 400);
    if (!(file instanceof File)) return apiError('VALIDATION_ERROR', 'A PDF file is required', 400);
    if (file.size > MAX_PDF_BYTES) return apiError('PAYLOAD_TOO_LARGE', 'PDF exceeds the 20MB limit', 413);

    const buffer = Buffer.from(await file.arrayBuffer());
    let pdfFilename: string;
    try {
      pdfFilename = await savePdfBuffer(buffer);
    } catch (err) {
      if (err instanceof InvalidPdfError) return apiError('VALIDATION_ERROR', err.message, 400);
      throw err;
    }

    const notes = typeof notesRaw === 'string' && notesRaw.trim() ? notesRaw.trim() : undefined;
    const record = await insertLegalRequest({
      title,
      category,
      receivedAt,
      notes,
      pdfFilename,
      createdBy: auth.relayId,
    });

    log.warn('[Admin] Legal request recorded:', record.id, category, 'by', auth.relayId);
    return NextResponse.json({ success: true, request: record }, { status: 200 });
  } catch (err) {
    if (err instanceof ApiError) return apiError(err.code, err.message, err.status);
    log.error('Unhandled API error (canary legal-request create):', err);
    captureException(err);
    return apiError('INTERNAL_ERROR', 'An unexpected error occurred', 500);
  }
}

/** Operator-only: remove a legal-request record and its on-disk PDF (e.g. correcting an upload mistake). */
export const DELETE = withErrorHandler(async (request: NextRequest) => {
  const rateLimited = checkRateLimit(request, 'admin:canary-legal-request-delete', { maxRequests: 20, windowMs: 60_000 });
  if (rateLimited) return rateLimited;

  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;

  const id = request.nextUrl.searchParams.get('id');
  if (!id) return apiError('VALIDATION_ERROR', 'Missing id', 400);

  const deleted = await deleteLegalRequest(id);
  if (!deleted) return apiError('NOT_FOUND', 'No such legal request', 404);
  await deletePdfFile(deleted.pdfFilename);

  log.warn('[Admin] Legal request deleted:', id, 'by', auth.relayId);
  return NextResponse.json({ success: true }, { status: 200 });
});
