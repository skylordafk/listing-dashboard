// SQLite database queries for the listing processor.
// Shares ~/ebay-listings.db with @ld/upload-api.

import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { applySchema } from '@ld/db';

const DB_PATH = process.env.DB_PATH ?? join(homedir(), 'ebay-listings.db');

let _db: Database.Database | undefined;

/** Get or create the shared SQLite connection. */
export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH, { timeout: 30_000 });
    _db.pragma('journal_mode = WAL');
    applySchema(_db);
  }
  return _db;
}

// ── Types ───────────────────────────────────────────────────────────

export interface ListingRow {
  id: number;
  odoo_product_id: number;
  odoo_product_name: string | null;
  status: string;
  listing_data: string;
  title: string | null;
  price: number | null;
  ebay_item_id: string | null;
  ebay_url: string | null;
  error_message: string | null;
  notes: string | null;
  created_at: string;
  approved_at: string | null;
  uploaded_at: string | null;
}

// ── Queries ─────────────────────────────────────────────────────────

export function getListingByProductId(
  db: Database.Database,
  productId: number,
): ListingRow | undefined {
  return db.prepare(
    'SELECT * FROM listings WHERE odoo_product_id = ?'
  ).get(productId) as ListingRow | undefined;
}

export function getListingById(
  db: Database.Database,
  id: number,
): ListingRow | undefined {
  return db.prepare('SELECT * FROM listings WHERE id = ?').get(id) as ListingRow | undefined;
}

export function getListingsByStatus(
  db: Database.Database,
  status: string,
): ListingRow[] {
  if (status === 'all') {
    return db.prepare(
      'SELECT * FROM listings ORDER BY approved_at DESC, created_at DESC'
    ).all() as ListingRow[];
  }
  return db.prepare(
    'SELECT * FROM listings WHERE status = ? ORDER BY approved_at DESC, created_at DESC'
  ).all(status) as ListingRow[];
}

export function getStatusCounts(
  db: Database.Database,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const status of ['draft', 'approved', 'rejected', 'uploading', 'uploaded', 'failed']) {
    const row = db.prepare(
      'SELECT COUNT(*) as c FROM listings WHERE status = ?'
    ).get(status) as { c: number };
    counts[status] = row.c;
  }
  counts.total = Object.values(counts).reduce((a, b) => a + b, 0);
  return counts;
}

export function upsertListing(
  db: Database.Database,
  productId: number,
  productName: string,
  status: string,
  listingData: string,
  title: string,
  price: number,
  extra?: {
    approved_at?: string;
    notes?: string;
    error_message?: string;
  },
): number {
  const existing = getListingByProductId(db, productId);

  if (existing) {
    const sets = ['status = ?', 'listing_data = ?', 'title = ?', 'price = ?'];
    const params: unknown[] = [status, listingData, title, price];

    if (extra?.approved_at) {
      sets.push('approved_at = ?');
      params.push(extra.approved_at);
    }
    if (extra?.notes !== undefined) {
      sets.push('notes = ?');
      params.push(extra.notes);
    }
    if (extra?.error_message !== undefined) {
      sets.push('error_message = ?');
      params.push(extra.error_message);
    }

    params.push(existing.id);
    db.prepare(`UPDATE listings SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    return existing.id;
  }

  const result = db.prepare(
    `INSERT INTO listings
     (odoo_product_id, odoo_product_name, status, listing_data, title, price, approved_at, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    productId, productName, status, listingData, title, price,
    extra?.approved_at ?? null, extra?.notes ?? null,
  );
  return Number(result.lastInsertRowid);
}

const ALLOWED_LISTING_COLUMNS = new Set([
  'status', 'listing_data', 'title', 'price', 'notes',
  'error_message', 'category_id', 'approved_at', 'ebay_item_id', 'uploaded_at',
]);

export function updateListingFields(
  db: Database.Database,
  id: number,
  fields: Record<string, unknown>,
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_LISTING_COLUMNS.has(key)) throw new Error(`Unexpected column: ${key}`);
    sets.push(`${key} = ?`);
    params.push(value);
  }
  if (sets.length === 0) return;
  params.push(id);
  db.prepare(`UPDATE listings SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function getListingProductIds(
  db: Database.Database,
  productIds: number[],
): Map<number, { id: number; status: string }> {
  const result = new Map<number, { id: number; status: string }>();
  if (productIds.length === 0) return result;

  const chunkSize = 900;
  for (let i = 0; i < productIds.length; i += chunkSize) {
    const chunk = productIds.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id, status, odoo_product_id FROM listings WHERE odoo_product_id IN (${placeholders})`
    ).all(...chunk) as Array<{ id: number; status: string; odoo_product_id: number }>;
    for (const row of rows) {
      result.set(row.odoo_product_id, { id: row.id, status: row.status });
    }
  }
  return result;
}
