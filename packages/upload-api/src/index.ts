import Fastify from 'fastify';
import cors from '@fastify/cors';
import { OdooClient } from '@ld/odoo-sdk';
import { EbayClient, EbayTaxonomyClient, EbayApiError, EbayAuthError, loadEbayConfig } from '@ld/ebay-client';
import type { ListingData } from '@ld/ebay-client';
import { loadApiKey } from './helpers.js';
import {
  getDb, getListingById, getApprovedListings, getAllListings,
  updateListingStatus, logUpload, getUploadLogs,
  hashText, getIdempotencyKey, storeIdempotencyKey,
  getCachedCategorySpecifics, setCachedCategorySpecifics,
  type ListingRow,
} from './db.js';

const PORT = Number(process.env.PORT ?? 5051);
const HOST = process.env.HOST ?? '0.0.0.0';

// ── Bootstrap ───────────────────────────────────────────────────────

const apiKey = loadApiKey();
const db = getDb();
const app = Fastify({ logger: true });

await app.register(cors, {
  origin: process.env.LISTING_PROCESSOR_ORIGIN ?? 'http://localhost:5050',
});

// ── Auth hook ───────────────────────────────────────────────────────

app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health') return;
  if (req.headers['x-api-key'] !== apiKey) {
    return reply.code(401).send({ error: 'Invalid or missing API key' });
  }
});

// ── Helpers ────────────────────────────────────────────────────────

function normalizeIdempotencyKey(req: { headers: Record<string, unknown> }): string | null {
  const key = String(req.headers['x-idempotency-key'] ?? '').trim();
  return key || null;
}

function checkIdempotencyReplay(
  operation: string,
  key: string,
  fingerprint: string,
): { body: unknown; status: number } | null {
  const row = getIdempotencyKey(db, operation, key);
  if (!row) return null;

  if (row.request_fingerprint !== fingerprint) {
    return {
      body: {
        status: 'error',
        error: 'Idempotency key reuse with different request payload',
        type: 'idempotency_key_mismatch',
      },
      status: 409,
    };
  }

  try {
    return { body: JSON.parse(row.response_body), status: row.response_status_code };
  } catch {
    return { body: { status: 'error', error: 'Invalid stored idempotency response' }, status: 500 };
  }
}

function ebayErrorResponse(err: unknown, listingId: number, action: string) {
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

// ── Upload logic ────────────────────────────────────────────────────

async function uploadListing(listing: ListingRow): Promise<{ body: Record<string, unknown>; code: number }> {
  const listingId = listing.id;
  const productId = listing.odoo_product_id;
  const listingData = JSON.parse(listing.listing_data) as ListingData;

  try {
    // Step 1: Mark uploading
    updateListingStatus(db, listingId, 'uploading');

    // Step 2: Fetch images from Odoo
    const odoo = OdooClient.fromEnv();
    const attachments = await odoo.searchRead<{ id: number; datas: string; name: string }>(
      'ir.attachment',
      [
        ['res_model', '=', 'product.template'],
        ['res_id', '=', productId],
        ['mimetype', 'like', 'image/'],
      ],
      { fields: ['datas', 'name'] },
    );

    // Step 3: Upload images to eBay
    const ebay = new EbayClient();
    const imageUrls: string[] = [];
    for (const att of attachments) {
      try {
        const url = await ebay.uploadPicture(att.datas, att.name ?? 'photo.jpg');
        imageUrls.push(url);
        logUpload(db, listingId, 'upload_picture', 'success');
      } catch (err) {
        logUpload(db, listingId, 'upload_picture', 'failure', (err as Error).message);
      }
    }

    // Step 4-5: Create eBay listing
    const result = await ebay.addItem(listingData, imageUrls);
    const ebayItemId = result.itemId;
    logUpload(db, listingId, 'add_item', 'success');

    // Step 6: Update SQLite
    const ebayUrl = `https://www.ebay.com/itm/${ebayItemId}`;
    updateListingStatus(db, listingId, 'uploaded', {
      ebay_item_id: ebayItemId,
      ebay_url: ebayUrl,
      uploaded_at: new Date().toISOString(),
    });

    // Step 7: Write back to Odoo
    try {
      await odoo.write('product.template', [productId], {
        x_ebay_item_id: ebayItemId,
        x_ebay_url: ebayUrl,
      });
    } catch (err) {
      console.error('Failed to update Odoo (non-fatal):', (err as Error).message);
    }

    return {
      body: {
        status: 'success',
        listing_id: listingId,
        ebay_item_id: ebayItemId,
        ebay_url: ebayUrl,
        images_uploaded: imageUrls.length,
      },
      code: 200,
    };
  } catch (err) {
    const errorMsg = (err instanceof EbayAuthError || err instanceof EbayApiError)
      ? `eBay ${err instanceof EbayAuthError ? 'auth' : 'API'} error: ${err.message}`
      : `Unexpected error: ${(err as Error).message}`;
    logUpload(db, listingId, 'add_item', 'failure', errorMsg);
    updateListingStatus(db, listingId, 'failed', { error_message: errorMsg });

    return {
      body: {
        status: 'error',
        listing_id: listingId,
        error: errorMsg,
        ...(err instanceof EbayAuthError ? { type: 'auth' } : {}),
      },
      code: err instanceof EbayAuthError ? 401 : err instanceof EbayApiError ? 502 : 500,
    };
  }
}

async function verifyListing(listing: ListingRow): Promise<{ body: Record<string, unknown>; code: number }> {
  const listingId = listing.id;
  const productId = listing.odoo_product_id;
  const listingData = JSON.parse(listing.listing_data) as ListingData;

  try {
    const odoo = OdooClient.fromEnv();
    const attachments = await odoo.searchRead<{ id: number; datas: string; name: string }>(
      'ir.attachment',
      [
        ['res_model', '=', 'product.template'],
        ['res_id', '=', productId],
        ['mimetype', 'like', 'image/'],
      ],
      { fields: ['datas', 'name'] },
    );

    const ebay = new EbayClient();
    const imageUrls: string[] = [];
    for (const att of attachments) {
      try {
        const url = await ebay.uploadPicture(att.datas, att.name ?? 'photo.jpg');
        imageUrls.push(url);
      } catch (err) {
        console.warn('Failed to upload image:', (err as Error).message);
      }
    }

    const result = await ebay.verifyAddItem(listingData, imageUrls);
    logUpload(db, listingId, 'verify_item', 'success');

    return {
      body: {
        status: 'success',
        listing_id: listingId,
        fees: result.fees,
        warnings: result.warnings,
        images_uploaded: imageUrls.length,
      },
      code: 200,
    };
  } catch (err) {
    const { body, code } = ebayErrorResponse(err, listingId, 'verify_item');
    return { body: body as Record<string, unknown>, code };
  }
}

// ── Routes ─────────────────────────────────────────────────────────

app.get('/health', async () => ({
  status: 'ok',
  version: '2.0',
  time: new Date().toISOString(),
}));

app.post('/api/test-connection', async (_req, reply) => {
  try {
    const ebay = new EbayClient();
    const result = await ebay.testConnection();
    return result;
  } catch (err) {
    if (err instanceof EbayAuthError) return reply.code(401).send({ status: 'error', error: err.message, type: 'auth' });
    if (err instanceof EbayApiError) return reply.code(502).send({ status: 'error', error: err.message });
    return reply.code(500).send({ status: 'error', error: (err as Error).message });
  }
});

app.get<{ Params: { categoryId: string }; Querystring: { site_id?: string; refresh?: string } }>(
  '/api/category-specifics/:categoryId',
  async (req, reply) => {
    const { categoryId } = req.params;
    const siteId = req.query.site_id ?? '0';
    const refresh = ['1', 'true', 'yes'].includes(req.query.refresh ?? '');

    // Check cache (24h TTL)
    if (!refresh) {
      const cached = getCachedCategorySpecifics(db, categoryId, siteId);
      if (cached?.fetched_at) {
        try {
          const fetchedAt = new Date(cached.fetched_at.replace('Z', '+00:00'));
          const ageMs = Date.now() - fetchedAt.getTime();
          if (ageMs < 86_400_000) {
            const payload = JSON.parse(cached.payload_json);
            return { ...payload, cached: true, fetched_at: cached.fetched_at };
          }
        } catch { /* stale cache, refetch */ }
      }
    }

    try {
      const ebay = new EbayClient();
      const payload = await ebay.getCategorySpecifics(categoryId, siteId);
      setCachedCategorySpecifics(db, categoryId, siteId, payload);
      return { ...payload, cached: false };
    } catch (err) {
      if (err instanceof EbayAuthError) return reply.code(401).send({ status: 'error', error: err.message, type: 'auth' });
      if (err instanceof EbayApiError) return reply.code(502).send({ status: 'error', error: err.message });
      return reply.code(500).send({ status: 'error', error: (err as Error).message });
    }
  },
);

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
    const replay = checkIdempotencyReplay('upload_single', idempotencyKey, fingerprint);
    if (replay) {
      return reply.code(replay.status).header('X-Idempotency-Replayed', 'true').send(replay.body);
    }
  }

  const { body, code } = await uploadListing(listing);
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
    const { body } = await uploadListing(listing);
    results.push(body);
  }

  const success = results.filter(r => r.status === 'success').length;
  const failed = results.filter(r => r.status === 'error').length;

  return { status: 'ok', total: results.length, success, failed, results };
});

app.post<{ Params: { listingId: string } }>('/api/verify/:listingId', async (req, reply) => {
  const listingId = Number(req.params.listingId);
  const listing = getListingById(db, listingId);
  if (!listing) return reply.code(404).send({ error: 'Listing not found' });
  if (!['approved', 'failed'].includes(listing.status)) {
    return reply.code(400).send({ error: `Listing status is '${listing.status}', must be 'approved' or 'failed'` });
  }

  const { body, code } = await verifyListing(listing);
  return reply.code(code).send(body);
});

app.post<{ Params: { listingId: string }; Body: { title?: string; price?: number; description_html?: string } }>(
  '/api/revise/:listingId',
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

    const listingData = JSON.parse(listing.listing_data) as Record<string, unknown>;
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
      const replay = checkIdempotencyReplay('revise_single', idempotencyKey, fingerprint);
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
      const { body: errBody, code } = ebayErrorResponse(err, listingId, 'revise_item');
      if (idempotencyKey) {
        storeIdempotencyKey(db, 'revise_single', idempotencyKey, listingId, fingerprint, errBody, code);
      }
      return reply.code(code).send(errBody);
    }
  },
);

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

// ── Start ──────────────────────────────────────────────────────────

// ── Taxonomy API routes ─────────────────────────────────────────────

const _taxonomyClient = (() => {
  try { return new EbayTaxonomyClient(loadEbayConfig()); }
  catch { return null; }
})();

app.get<{ Querystring: { q: string } }>(
  '/api/category-suggestions',
  async (req, reply) => {
    const query = (req.query.q ?? '').trim();
    if (!query) return reply.code(400).send({ error: 'Query parameter q is required' });
    if (!_taxonomyClient) return reply.code(500).send({ error: 'Taxonomy client not configured' });

    try {
      const result = await _taxonomyClient.getCategorySuggestions(query);
      return result;
    } catch (err) {
      if (err instanceof EbayAuthError) return reply.code(401).send({ status: 'error', error: err.message, type: 'auth' });
      if (err instanceof EbayApiError) return reply.code(502).send({ status: 'error', error: err.message });
      return reply.code(500).send({ status: 'error', error: (err as Error).message });
    }
  },
);

app.get<{ Params: { categoryId: string }; Querystring: { refresh?: string } }>(
  '/api/taxonomy/aspects/:categoryId',
  async (req, reply) => {
    const { categoryId } = req.params;
    const refresh = ['1', 'true', 'yes'].includes(req.query.refresh ?? '');
    if (!_taxonomyClient) return reply.code(500).send({ error: 'Taxonomy client not configured' });

    // Check cache (24h TTL) — reuse existing cache table
    const cacheKey = `taxonomy_${categoryId}`;
    if (!refresh) {
      const cached = getCachedCategorySpecifics(db, cacheKey, '0');
      if (cached?.fetched_at) {
        try {
          const fetchedAt = new Date(cached.fetched_at.replace('Z', '+00:00'));
          const ageMs = Date.now() - fetchedAt.getTime();
          if (ageMs < 86_400_000) {
            return { ...JSON.parse(cached.payload_json), cached: true, fetched_at: cached.fetched_at };
          }
        } catch { /* stale cache, refetch */ }
      }
    }

    try {
      const result = await _taxonomyClient.getItemAspects(categoryId);
      setCachedCategorySpecifics(db, cacheKey, '0', result);
      return { ...result, cached: false };
    } catch (err) {
      if (err instanceof EbayAuthError) return reply.code(401).send({ status: 'error', error: err.message, type: 'auth' });
      if (err instanceof EbayApiError) return reply.code(502).send({ status: 'error', error: err.message });
      return reply.code(500).send({ status: 'error', error: (err as Error).message });
    }
  },
);

const address = await app.listen({ port: PORT, host: HOST });
console.log(`\n📦 Upload API listening on ${address}`);
console.log(`🔑 API key loaded (${apiKey.slice(0, 8)}...)\n`);
