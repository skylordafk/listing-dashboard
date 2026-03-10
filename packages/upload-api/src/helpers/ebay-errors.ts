import type Database from 'better-sqlite3';
import { EbayApiError, EbayAuthError } from '@ld/ebay-client';
import { logUpload } from '../db.js';

export function ebayErrorResponse(
  db: Database.Database,
  err: unknown,
  listingId: number,
  action: string,
) {
  if (err instanceof EbayAuthError) {
    const msg = `eBay auth error: ${err.message}`;
    logUpload(db, listingId, action, 'failure', msg);
    return { body: { status: 'error', listing_id: listingId, error: err.message, type: 'auth' }, code: 401 };
  }
  if (err instanceof EbayApiError) {
    const msg = `eBay API error: ${err.message}`;
    logUpload(db, listingId, action, 'failure', msg);
    return { body: { status: 'error', listing_id: listingId, error: err.message }, code: 502 };
  }
  const msg = `Unexpected error: ${(err as Error).message}`;
  logUpload(db, listingId, action, 'failure', msg);
  return { body: { status: 'error', listing_id: listingId, error: msg }, code: 500 };
}
