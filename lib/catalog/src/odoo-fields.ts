// ── Odoo Field Contract ──────────────────────────────────────────────
//
// The canonical list of Odoo custom fields that both intake-station and
// listing-dashboard agree on. Odoo is the storage layer — these field
// names are the persistence mapping, not the schema authority.
//
// Adding a field here means both projects can read/write it.
// Removing a field here should trigger a build error in any project
// that still references it.

/**
 * Odoo fields written by intake-station's enrichment pipeline.
 * listing-dashboard reads these to populate the review UI and eBay upload.
 */
export const ODOO_ENRICHMENT_FIELDS = [
  'x_ebay_category_id',
  'x_ebay_item_specifics',
  'x_brand',
  'x_model_name',
  'x_series',
  'x_condition',
  'x_cosmetic_notes',
  'x_functional_notes',
] as const;

export type OdooEnrichmentField = typeof ODOO_ENRICHMENT_FIELDS[number];

/**
 * Odoo fields written by listing-dashboard after eBay upload.
 * These track the listing lifecycle and are not read by intake-station.
 */
export const ODOO_LISTING_FIELDS = [
  'x_ebay_listing_id',
  'x_ebay_listing_status',
  'x_ebay_listing_url',
  'x_ebay_sold_price',
  'x_ebay_sold_date',
] as const;

export type OdooListingField = typeof ODOO_LISTING_FIELDS[number];

/**
 * All Odoo custom fields used across both systems.
 */
export const ODOO_ALL_FIELDS = [
  ...ODOO_ENRICHMENT_FIELDS,
  ...ODOO_LISTING_FIELDS,
] as const;
