import type { FastifyInstance } from 'fastify';
import { getDb, getListingById, getAllListings, getUploadLogs } from '../db.js';

export default async function (app: FastifyInstance) {
  const db = getDb();

  app.get<{ Params: { listingId: string } }>('/api/status/:listingId', async (req, reply) => {
    const listingId = Number(req.params.listingId);
    const listing = getListingById(db, listingId);
    if (!listing) return reply.code(404).send({ error: 'Listing not found' });

    const logs = getUploadLogs(db, listingId);

    return {
      listing_id: listing.id,
      odoo_product_id: listing.odoo_product_id,
      title: listing.title,
      status: listing.status,
      ebay_item_id: listing.ebay_item_id,
      ebay_url: listing.ebay_url,
      error_message: listing.error_message,
      logs: logs.map(l => ({
        action: l.action,
        status: l.status,
        error: l.error_details,
        time: l.created_at,
      })),
    };
  });

  app.get('/api/status', async () => {
    const listings = getAllListings(db);
    return {
      listings: listings.map(l => ({
        id: l.id,
        odoo_product_id: l.odoo_product_id,
        name: l.odoo_product_name,
        title: l.title,
        status: l.status,
        ebay_item_id: l.ebay_item_id,
        error: l.error_message,
        created: l.created_at,
        uploaded: l.uploaded_at,
      })),
    };
  });
}
