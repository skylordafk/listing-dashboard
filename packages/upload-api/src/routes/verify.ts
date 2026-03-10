import type { FastifyInstance } from 'fastify';
import { getDb, getListingById } from '../db.js';
import { verifyListing } from '../helpers/upload-logic.js';

export default async function (app: FastifyInstance) {
  const db = getDb();

  app.post<{ Params: { listingId: string } }>('/api/verify/:listingId', async (req, reply) => {
    const listingId = Number(req.params.listingId);
    const listing = getListingById(db, listingId);
    if (!listing) return reply.code(404).send({ error: 'Listing not found' });
    if (!['approved', 'failed'].includes(listing.status)) {
      return reply.code(400).send({ error: `Listing status is '${listing.status}', must be 'approved' or 'failed'` });
    }

    const { body, code } = await verifyListing(db, listing);
    return reply.code(code).send(body);
  });
}
