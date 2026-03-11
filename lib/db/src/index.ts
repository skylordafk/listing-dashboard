// Shared SQLite schema for listing-dashboard.
// Both listing-processor and upload-api share ~/ebay-listings.db.

import type Database from 'better-sqlite3';

/**
 * Apply the shared DDL (listings + upload_log tables) to the given database.
 * Each service may apply additional service-specific tables after calling this.
 */
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

// ── Shared Queries ──────────────────────────────────────────────────

export function getListingById(
  db: Database.Database,
  id: number,
): ListingRow | undefined {
  return db.prepare('SELECT * FROM listings WHERE id = ?').get(id) as ListingRow | undefined;
}

// ── Schema ──────────────────────────────────────────────────────────

export function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      odoo_product_id INTEGER NOT NULL UNIQUE,
      odoo_product_name TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      listing_data TEXT NOT NULL,
      title TEXT,
      price REAL,
      ebay_item_id TEXT,
      ebay_url TEXT,
      error_message TEXT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      approved_at TIMESTAMP,
      uploaded_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS upload_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL REFERENCES listings(id),
      action TEXT NOT NULL,
      status TEXT,
      error_details TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
