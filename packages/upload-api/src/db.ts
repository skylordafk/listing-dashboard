import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { applySchema } from '@ld/db';

const DB_PATH = process.env.DB_PATH ?? join(homedir(), 'ebay-listings.db');

let _db: Database.Database | undefined;

/** Get or create the shared SQLite connection. */
export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH, { timeout: 30_000 });
    _db.pragma('journal_mode = WAL');
    applySchema(_db);
    applyUploadApiSchema(_db);
  }
  return _db;
}

/** Initialize Upload API-specific tables. */
function applyUploadApiSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operation TEXT NOT NULL,
      key TEXT NOT NULL,
      listing_id INTEGER,
      request_fingerprint TEXT NOT NULL,
      response_status_code INTEGER NOT NULL,
      response_body TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(operation, key)
    );

    CREATE TABLE IF NOT EXISTS category_specifics_cache (
      category_id TEXT NOT NULL,
      category_site_id TEXT NOT NULL DEFAULT '0',
      payload_json TEXT NOT NULL,
      fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (category_id, category_site_id)
    );
  `);
}

// ── Listing queries ─────────────────────────────────────────────────

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

export function getListingById(db: Database.Database, id: number): ListingRow | undefined {
  return db.prepare('SELECT * FROM listings WHERE id = ?').get(id) as ListingRow | undefined;
}

export function getApprovedListings(db: Database.Database): ListingRow[] {
  return db.prepare(
    "SELECT * FROM listings WHERE status = 'approved' ORDER BY approved_at ASC"
  ).all() as ListingRow[];
}

export function getAllListings(db: Database.Database): ListingRow[] {
  return db.prepare(
    'SELECT id, odoo_product_id, odoo_product_name, title, status, ' +
    'ebay_item_id, error_message, created_at, uploaded_at ' +
    'FROM listings ORDER BY id DESC'
  ).all() as ListingRow[];
}

interface ListingStatusExtra {
  ebay_item_id?: string;
  ebay_url?: string;
  uploaded_at?: string;
  listing_data?: string;
  title?: string;
  error_message?: string;
}

export function updateListingStatus(
  db: Database.Database,
  id: number,
  status: string,
  extra?: ListingStatusExtra,
): void {
  const sets = ['status = ?', 'error_message = ?'];
  const params: unknown[] = [status, extra?.error_message ?? null];

  if (extra?.ebay_item_id) {
    sets.push('ebay_item_id = ?', 'ebay_url = ?', 'uploaded_at = ?');
    params.push(
      extra.ebay_item_id,
      extra.ebay_url ?? `https://www.ebay.com/itm/${extra.ebay_item_id}`,
      extra.uploaded_at ?? new Date().toISOString(),
    );
  }
  if (extra?.listing_data) {
    sets.push('listing_data = ?');
    params.push(extra.listing_data);
  }
  if (extra?.title) {
    sets.push('title = ?');
    params.push(extra.title);
  }

  params.push(id);
  db.prepare(`UPDATE listings SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

// ── Upload log ──────────────────────────────────────────────────────

export function logUpload(
  db: Database.Database,
  listingId: number,
  action: string,
  status: string,
  errorDetails?: string | null,
): void {
  db.prepare(
    'INSERT INTO upload_log (listing_id, action, status, error_details) VALUES (?, ?, ?, ?)'
  ).run(listingId, action, status, errorDetails ?? null);
}

export interface UploadLogRow {
  id: number;
  listing_id: number;
  action: string;
  status: string;
  error_details: string | null;
  created_at: string;
}

export function getUploadLogs(db: Database.Database, listingId: number): UploadLogRow[] {
  return db.prepare(
    'SELECT * FROM upload_log WHERE listing_id = ? ORDER BY created_at DESC'
  ).all(listingId) as UploadLogRow[];
}

// ── Idempotency ─────────────────────────────────────────────────────

export function hashText(value: string): string {
  return createHash('sha256').update(value || '').digest('hex');
}

export interface IdempotencyRow {
  request_fingerprint: string;
  response_status_code: number;
  response_body: string;
}

export function getIdempotencyKey(
  db: Database.Database,
  operation: string,
  key: string,
): IdempotencyRow | undefined {
  return db.prepare(
    'SELECT request_fingerprint, response_status_code, response_body ' +
    'FROM idempotency_keys WHERE operation = ? AND key = ?'
  ).get(operation, key) as IdempotencyRow | undefined;
}

export function storeIdempotencyKey(
  db: Database.Database,
  operation: string,
  key: string,
  listingId: number,
  fingerprint: string,
  responseBody: unknown,
  statusCode: number,
): void {
  try {
    db.prepare(
      'INSERT INTO idempotency_keys ' +
      '(operation, key, listing_id, request_fingerprint, response_status_code, response_body) ' +
      'VALUES (?, ?, ?, ?, ?, ?)'
    ).run(operation, key, listingId, fingerprint, statusCode, JSON.stringify(responseBody));
  } catch {
    // IntegrityError: another request already stored this key; keep the first.
  }
}

// ── Category specifics cache ──────────────────────────────────────────

export interface CacheRow {
  payload_json: string;
  fetched_at: string;
}

export function getCachedCategorySpecifics(
  db: Database.Database,
  categoryId: string,
  siteId: string,
): CacheRow | undefined {
  return db.prepare(
    'SELECT payload_json, fetched_at FROM category_specifics_cache ' +
    'WHERE category_id = ? AND category_site_id = ?'
  ).get(categoryId, siteId) as CacheRow | undefined;
}

export function setCachedCategorySpecifics(
  db: Database.Database,
  categoryId: string,
  siteId: string,
  payload: unknown,
): void {
  db.prepare(
    'INSERT OR REPLACE INTO category_specifics_cache ' +
    '(category_id, category_site_id, payload_json, fetched_at) VALUES (?, ?, ?, ?)'
  ).run(categoryId, siteId, JSON.stringify(payload), new Date().toISOString());
}
