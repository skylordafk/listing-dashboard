// Shared SQLite schema for listing-dashboard.
// Both listing-processor and upload-api share ~/ebay-listings.db.

import type Database from 'better-sqlite3';

/**
 * Apply the shared DDL (listings + upload_log tables) to the given database.
 * Each service may apply additional service-specific tables after calling this.
 */
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
