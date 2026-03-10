// Listing data helpers.

import type Database from 'better-sqlite3';
import DOMPurify from 'isomorphic-dompurify';
import { getListingByProductId, type ListingRow } from '../db.js';
import { finalizeListingData, type ListingData } from '../normalizer.js';
import { loadEbayAppConfig } from '../config.js';

export function getExistingListing(
  db: Database.Database,
  productId: number,
): { existing: ListingRow | undefined; savedData: Record<string, unknown> } {
  const existing = getListingByProductId(db, productId);
  if (!existing) return { existing: undefined, savedData: {} };
  let savedData: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(existing.listing_data ?? '{}');
    if (typeof parsed === 'object' && parsed !== null) savedData = parsed;
  } catch { /* ignore */ }
  return { existing, savedData };
}

export function mergeSavedListingData(
  listingData: ListingData,
  savedData: Record<string, unknown>,
): ListingData {
  if (!savedData || Object.keys(savedData).length === 0) return listingData;
  const merged = { ...listingData } as Record<string, unknown>;
  for (const [key, value] of Object.entries(savedData)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value === '') continue;
    merged[key] = value;
  }
  return merged as ListingData;
}

export function listingDataFromSavedOnly(
  existing: ListingRow,
  savedData: Record<string, unknown>,
): ListingData {
  const data = { ...savedData } as ListingData;
  if (!data.title) data.title = existing.title ?? 'Untitled Listing';
  if (data.price == null) data.price = existing.price ?? 0;
  data.condition_description ??= '';
  data.description_html ??= '';
  data.item_specifics ??= [];
  const ebayConfig = loadEbayAppConfig();
  return finalizeListingData(data, undefined, ebayConfig.default_condition_description);
}

/** Sanitize description_html on a listing data object before template rendering. */
export function sanitizeListingHtml(listingData: ListingData): ListingData {
  if (listingData.description_html) {
    listingData = {
      ...listingData,
      description_html: DOMPurify.sanitize(listingData.description_html),
    };
  }
  return listingData;
}
