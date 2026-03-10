import type { FastifyInstance } from 'fastify';
import { EbayClient } from '@ld/ebay-client';
import {
  getDb, getListingById, updateListingStatus,
  logUpload, hashText, storeIdempotencyKey,
} from '../db.js';
import { normalizeIdempotencyKey, checkIdempotencyReplay } from '../helpers/idempotency.js';
import { ebayErrorResponse } from '../helpers/ebay-errors.js';

const reviseBodySchema = {
  type: 'object',
  properties: {
    title:            { type: 'string', minLength: 1, maxLength: 80 },
    price:            { type: 'number', minimum: 0.01, maximum: 999999 },
    description_html: { type: 'string', maxLength: 500_000 },
  },
  additionalProperties: false,
};

export default async function (app: FastifyInstance) {
  const db = getDb();

  app.post<{ Params: { listingId: string }; Body: { title?: string; price?: number; description_html?: string } }>(
    '/api/revise/:listingId',
    { schema: { body: reviseBodySchema } },
    async (req, reply) => {
      const listingId = Number(req.params.listingId);
      const listing = getListingById(db, listingId);
      if (!listing) return reply.code(404).send({ error: 'Listing not found' });
      if (listing.status !== 'uploaded') {
        return reply.code(400).send({ error: `Listing not uploaded (status: '${listing.status}')` });
      }
      if (!listing.ebay_item_id) {
        return reply.code(400).send({ error: 'No eBay item ID on this listing' });
      }

      let listingData: Record<string, unknown>;
      try {
        listingData = JSON.parse(listing.listing_data) as Record<string, unknown>;
      } catch (err) {
        return reply.code(400).send({ status: 'error', error: `Invalid listing_data JSON: ${(err as Error).message}` });
      }
      const body = req.body ?? {};

      const updates: Record<string, unknown> = {};
      for (const field of ['description_html', 'title', 'price'] as const) {
        if (body[field] != null) updates[field] = body[field];
        else if (listingData[field] != null) updates[field] = listingData[field];
      }

      if (!Object.keys(updates).length) {
        return reply.code(400).send({ error: 'Nothing to revise' });
      }

      const idempotencyKey = normalizeIdempotencyKey(req);
      const fingerprint = hashText(JSON.stringify(updates, Object.keys(updates).sort()));
      if (idempotencyKey) {
        const replay = checkIdempotencyReplay(db, 'revise_single', idempotencyKey, fingerprint);
        if (replay) {
          return reply.code(replay.status).header('X-Idempotency-Replayed', 'true').send(replay.body);
        }
      }

      try {
        const ebay = new EbayClient();
        await ebay.reviseItem(
          listing.ebay_item_id,
          updates as { title?: string; price?: number; description_html?: string },
        );
        logUpload(db, listingId, 'revise_item', 'success');

        // Update listing_data in DB
        for (const [field, value] of Object.entries(updates)) {
          listingData[field] = value;
        }
        updateListingStatus(db, listingId, 'uploaded', {
          listing_data: JSON.stringify(listingData),
          title: listingData.title as string,
        });

        const responseBody = {
          status: 'success',
          ebay_item_id: listing.ebay_item_id,
          revised_fields: Object.keys(updates),
        };
        if (idempotencyKey) {
          storeIdempotencyKey(db, 'revise_single', idempotencyKey, listingId, fingerprint, responseBody, 200);
        }
        return responseBody;
      } catch (err) {
        const { body: errBody, code } = ebayErrorResponse(db, err, listingId, 'revise_item');
        if (idempotencyKey) {
          storeIdempotencyKey(db, 'revise_single', idempotencyKey, listingId, fingerprint, errBody, code);
        }
        return reply.code(code).send(errBody);
      }
    },
  );
}
