import type Database from 'better-sqlite3';
import { OdooClient, getAttachmentsWithData } from '@ld/odoo-sdk';
import { EbayClient, EbayApiError, EbayAuthError } from '@ld/ebay-client';
import type { ListingData } from '@ld/ebay-client';
import {
  updateListingStatus, logUpload,
  type ListingRow,
} from '../db.js';
import { ebayErrorResponse } from './ebay-errors.js';

export async function uploadListing(
  db: Database.Database,
  listing: ListingRow,
): Promise<{ body: Record<string, unknown>; code: number }> {
  const listingId = listing.id;
  const productId = listing.odoo_product_id;

  try {
    const listingData = JSON.parse(listing.listing_data) as ListingData;

    // Step 1: Atomically claim the listing (prevents duplicate eBay uploads from
    // concurrent batch requests both seeing the same 'approved' listing)
    const claim = db.prepare(
      "UPDATE listings SET status = 'uploading' WHERE id = ? AND status IN ('approved', 'failed')"
    ).run(listingId);
    if (claim.changes === 0) {
      // Another request already claimed this listing
      return {
        body: { status: 'skipped', listing_id: listingId, reason: 'Listing was claimed by another request' },
        code: 200,
      };
    }

    // Step 2: Fetch images from Odoo
    const odoo = OdooClient.fromEnv();
    const attachments = await getAttachmentsWithData(odoo, productId);

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

    if (imageUrls.length === 0 && attachments.length > 0) {
      const errMsg = 'All image uploads failed — no images available for listing';
      updateListingStatus(db, listingId, 'failed', { error_message: errMsg });
      return {
        body: { status: 'error', listing_id: listingId, error: errMsg },
        code: 502,
      };
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

export async function verifyListing(
  db: Database.Database,
  listing: ListingRow,
): Promise<{ body: Record<string, unknown>; code: number }> {
  const listingId = listing.id;
  const productId = listing.odoo_product_id;

  try {
    const listingData = JSON.parse(listing.listing_data) as ListingData;
    const odoo = OdooClient.fromEnv();
    const attachments = await getAttachmentsWithData(odoo, productId);

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

    if (imageUrls.length === 0 && attachments.length > 0) {
      return {
        body: {
          status: 'error',
          listing_id: listingId,
          error: 'All image uploads failed — no images available for listing',
        },
        code: 502,
      };
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
    const { body, code } = ebayErrorResponse(db, err, listingId, 'verify_item');
    return { body: body as Record<string, unknown>, code };
  }
}
