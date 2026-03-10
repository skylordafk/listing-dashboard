import type { FastifyInstance } from 'fastify';
import {
  getDb, getListingById, getApprovedListings,
  hashText, storeIdempotencyKey,
} from '../db.js';
import { normalizeIdempotencyKey, checkIdempotencyReplay } from '../helpers/idempotency.js';
import { uploadListing } from '../helpers/upload-logic.js';

export default async function (app: FastifyInstance) {
  const db = getDb();

  app.post<{ Params: { listingId: string } }>('/api/upload/:listingId', async (req, reply) => {
    const listingId = Number(req.params.listingId);
    const listing = getListingById(db, listingId);
    if (!listing) return reply.code(404).send({ error: 'Listing not found' });
    if (!['approved', 'failed'].includes(listing.status)) {
      return reply.code(400).send({ error: `Listing status is '${listing.status}', must be 'approved' or 'failed'` });
    }

    const idempotencyKey = normalizeIdempotencyKey(req);
    const fingerprint = hashText(listing.listing_data);
    if (idempotencyKey) {
      const replay = checkIdempotencyReplay(db, 'upload_single', idempotencyKey, fingerprint);
      if (replay) {
        return reply.code(replay.status).header('X-Idempotency-Replayed', 'true').send(replay.body);
      }
    }

    const { body, code } = await uploadListing(db, listing);
    if (idempotencyKey) {
      storeIdempotencyKey(db, 'upload_single', idempotencyKey, listingId, fingerprint, body, code);
    }
    return reply.code(code).send(body);
  });

  app.post('/api/upload/batch', async () => {
    const listings = getApprovedListings(db);
    if (!listings.length) {
      return { status: 'ok', message: 'No approved listings to upload', results: [] };
    }

    const results: Record<string, unknown>[] = [];
    for (const listing of listings) {
      const { body } = await uploadListing(db, listing);
      results.push(body);
    }

    const success = results.filter(r => r.status === 'success').length;
    const failed = results.filter(r => r.status === 'error').length;

    return { status: 'ok', total: results.length, success, failed, results };
  });
}
