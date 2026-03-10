// Queue routes: list, verify, upload.

import type { FastifyInstance } from 'fastify';
import {
  getDb, getListingsByStatus, getStatusCounts, getListingById, updateListingFields,
} from '../db.js';
import {
  callUploadApi, buildIdempotencyKey, extractNonzeroFees, formatUploadApiError,
  type UploadResponseData,
} from '../upload-client.js';
import { loadUploadApiKey } from '../config.js';
import { flash } from '../helpers/flash.js';
import { render } from '../helpers/render.js';

export default async function (app: FastifyInstance) {

  // ── Queue List ─────────────────────────────────────────────────────

  app.get<{ Querystring: { status?: string } }>('/queue', async (req, reply) => {
    const db = getDb();
    const statusFilter = req.query.status ?? 'approved';
    const listings = getListingsByStatus(db, statusFilter);
    const statusCounts = getStatusCounts(db);

    reply.type('text/html');
    return render(req, reply, 'queue', {
      listings, statusFilter, statusCounts, activeNav: 'queue',
    });
  });

  // ── Verify Listing ─────────────────────────────────────────────────

  app.post<{ Params: { listingId: string } }>('/listing/:listingId/verify', async (req, reply) => {
    const listingId = Number(req.params.listingId);
    const apiKey = loadUploadApiKey();
    if (!apiKey) { flash(reply, 'error', 'Upload API key not configured'); return reply.redirect('/queue'); }

    try {
      const result = await callUploadApi(`/api/verify/${listingId}`, {
        timeout: 120, retries: 1, retryOn5xx: true,
      });

      if (!result.ok) {
        flash(reply, 'error', formatUploadApiError(result, 'Verify'));
        return reply.redirect('/queue');
      }

      const data = result.data!;
      if (data.status === 'success') {
        const fees = extractNonzeroFees((data.fees as unknown[]) ?? []);
        if (fees.length > 0) {
          const feeParts = fees.map(f => `${f.name}: $${f.amount.toFixed(2)}`);
          flash(reply, 'success', `eBay validation passed. Fees: ${feeParts.join(', ')}`);
        } else {
          flash(reply, 'success', 'eBay validation passed (no fees).');
        }
        const warnings = (data.warnings as Array<{ code: string; message: string }>) ?? [];
        for (const w of warnings) {
          flash(reply, 'warning', `eBay warning [${w.code}]: ${w.message}`);
        }
      } else {
        flash(reply, 'error', `eBay validation failed: ${data.error ?? 'Unknown error'}`);
      }
    } catch (err) {
      flash(reply, 'error', `Verify error: ${(err as Error).message}`);
    }

    return reply.redirect('/queue');
  });

  // ── Upload Listing ─────────────────────────────────────────────────

  app.post<{ Params: { listingId: string } }>('/listing/:listingId/upload', async (req, reply) => {
    const db = getDb();
    const listingId = Number(req.params.listingId);
    const apiKey = loadUploadApiKey();
    if (!apiKey) { flash(reply, 'error', 'Upload API key not configured'); return reply.redirect('/queue'); }

    try {
      const listing = getListingById(db, listingId);
      const fingerprint = listing?.listing_data ?? String(listingId);
      const idempotencyKey = buildIdempotencyKey('upload', listingId, fingerprint);

      const result = await callUploadApi(`/api/upload/${listingId}`, {
        timeout: 180, retries: 0, retryOn5xx: false, idempotencyKey,
      });

      if (!result.ok) {
        flash(reply, 'error', formatUploadApiError(result, 'Upload'));
        return reply.redirect('/queue');
      }

      const data = result.data as UploadResponseData;
      if (data.status === 'success') {
        const ebayItemId = data.ebay_item_id;
        if (!ebayItemId) {
          updateListingFields(db, listingId, {
            status: 'failed',
            error_message: 'Upload reported success but returned no eBay item ID',
          });
          flash(reply, 'error', 'Upload API reported success but did not return an eBay item ID. Check upload-api logs.');
          return reply.redirect('/queue');
        }
        updateListingFields(db, listingId, {
          status: 'uploaded',
          ebay_item_id: ebayItemId,
          uploaded_at: new Date().toISOString(),
        });
        flash(reply, 'success', `✅ Listed on eBay! Item ID: ${ebayItemId}`);

        const fees = extractNonzeroFees(data.fees ?? []);
        if (fees.length > 0) {
          flash(reply, 'info', `Fees: ${fees.map(f => `${f.name}: $${f.amount.toFixed(2)}`).join(', ')}`);
        }
        const warnings = data.warnings ?? [];
        for (const w of warnings) flash(reply, 'warning', `eBay warning [${w.code}]: ${w.message}`);
      } else {
        const errorMsg = String(data.error ?? 'Unknown error').slice(0, 500);
        updateListingFields(db, listingId, { status: 'failed', error_message: errorMsg });
        flash(reply, 'error', `Upload failed: ${errorMsg}`);
      }
    } catch (err) {
      flash(reply, 'error', `Upload error: ${(err as Error).message}`);
    }

    return reply.redirect('/queue');
  });
}
