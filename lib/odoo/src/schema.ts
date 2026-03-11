// Schema types derived from Odoo fields_get on product.product
// Database: spv-oodo | Generated: 2026-02-15
// DO NOT hand-edit selection values — regenerate from Odoo if schema changes.

// ── Selection Value Types ──────────────────────────────────────────────

export type ProductType = 'consu' | 'service' | 'combo';

export type RamSize = '1gb' | '2gb' | '4gb' | '8gb' | '16gb' | '32gb' | '64gb';

export type StorageType = 'ssd' | 'hdd' | 'hdd_ssd' | 'nvme' | 'emmc';

export type Condition = 'new' | 'like_new' | 'good' | 'fair' | 'parts';

export type Color = 'black' | 'silver' | 'gray' | 'white' | 'gold' | 'blue' | 'red' | 'other';

export type GraphicsType = 'integrated' | 'dedicated' | 'hybrid';

export type LaptopType = 'notebook' | 'ultrabook' | 'subnotebook' | 'netbook' | 'convertible';

export type OperatingSystem =
  | 'win11pro' | 'win11home'
  | 'win10pro' | 'win10home' | 'win10'
  | 'win7pro' | 'win7'
  | 'linux' | 'chromeos' | 'not_included' | 'ubuntu';

export type TestResult = 'untested' | 'pass' | 'fail' | 'issues';

export type EbayStatus = 'pending' | 'active' | 'sold' | 'unsold' | 'ended';

// ── Product Schema ─────────────────────────────────────────────────────

/** Full product record as returned by Odoo search_read. */
export interface OdooProduct {
  // Identity
  id: number;
  name: string;
  default_code: string | false;  // Internal Reference (asset ID)
  barcode: string | false;
  active: boolean;
  type: ProductType;
  categ_id: [number, string] | false;  // [id, display_name]

  // Pricing
  list_price: number;
  standard_price: number;

  // Stock
  qty_available: number;

  // Image (base64-encoded, often large — request sparingly)
  image_1920: string | false;

  // ── Custom Fields ──────────────────────────────────────────────────

  // Device identity
  x_brand: string | false;
  x_model_name: string | false;
  x_series: string | false;
  x_laptop_type: LaptopType | false;
  x_color: Color | false;
  x_release_year: number | false;

  // Specs
  x_processor: string | false;
  x_processor_speed: string | false;
  x_ram_size: RamSize | false;
  x_storage_capacity: string | false;
  x_storage_type: StorageType | false;
  x_gpu: string | false;
  x_graphics_type: GraphicsType | false;
  x_screen_size: string | false;
  x_max_resolution: string | false;
  x_operating_system: OperatingSystem | false;

  // Features
  x_has_touchscreen: boolean;
  x_has_backlit_keyboard: boolean;
  x_has_fingerprint: boolean;
  x_connectivity: string | false;
  x_port_inventory: string | false;  // text field
  x_features: string | false;
  x_webcam_resolution: string | false;

  // Condition
  x_condition: Condition | false;
  x_cosmetic_notes: string | false;  // text field
  x_functional_notes: string | false;  // text field

  // Battery
  x_battery_health: string | false;
  x_battery_cycles: number | false;

  // Test results
  x_test_battery: TestResult | false;
  x_test_bluetooth: TestResult | false;
  x_test_display: TestResult | false;
  x_test_keyboard: TestResult | false;
  x_test_microphone: TestResult | false;
  x_test_ports: TestResult | false;
  x_test_speakers: TestResult | false;
  x_test_touchpad: TestResult | false;
  x_test_webcam: TestResult | false;
  x_test_wifi: TestResult | false;

  // eBay Enrichment (written by intake-station)
  x_ebay_category_id: string | false;
  x_ebay_item_specifics: string | false;  // JSON blob from intake-station enrichment

  // eBay Performance Tracking
  x_ebay_item_id: string | false;
  x_ebay_status: EbayStatus | false;
  x_ebay_listed_date: string | false;  // date string YYYY-MM-DD
  x_ebay_sold_date: string | false;    // date string YYYY-MM-DD
  x_ebay_sold_price: number;
  x_ebay_watchers: number;
  x_ebay_views: number;
  x_ebay_impressions: number;
  x_ebay_ctr: number;
  x_ebay_fees: number;
  x_ebay_ad_spend: number;
  x_ebay_days_to_sell: number;
}

// ── Image Attachment ───────────────────────────────────────────────────

/** A product image attachment as returned by Odoo. */
export interface OdooImage {
  id: number;
  datas: string;   // base64-encoded
  name: string;
  mimetype: string;
}

// ── Field Lists ────────────────────────────────────────────────────────

/** All custom (x_) field names. */
export const CUSTOM_FIELDS = [
  'x_brand', 'x_model_name', 'x_series', 'x_laptop_type', 'x_color', 'x_release_year',
  'x_processor', 'x_processor_speed', 'x_ram_size', 'x_storage_capacity', 'x_storage_type',
  'x_gpu', 'x_graphics_type', 'x_screen_size', 'x_max_resolution', 'x_operating_system',
  'x_has_touchscreen', 'x_has_backlit_keyboard', 'x_has_fingerprint',
  'x_connectivity', 'x_port_inventory', 'x_features', 'x_webcam_resolution',
  'x_condition', 'x_cosmetic_notes', 'x_functional_notes',
  'x_battery_health', 'x_battery_cycles',
  'x_test_battery', 'x_test_bluetooth', 'x_test_display', 'x_test_keyboard',
  'x_test_microphone', 'x_test_ports', 'x_test_speakers', 'x_test_touchpad',
  'x_test_webcam', 'x_test_wifi',
  // eBay enrichment (intake-station)
  'x_ebay_category_id', 'x_ebay_item_specifics',
  // eBay performance
  'x_ebay_item_id', 'x_ebay_status', 'x_ebay_listed_date', 'x_ebay_sold_date',
  'x_ebay_sold_price', 'x_ebay_watchers', 'x_ebay_views', 'x_ebay_impressions',
  'x_ebay_ctr', 'x_ebay_fees', 'x_ebay_ad_spend', 'x_ebay_days_to_sell',
] as const;

/** Standard fields commonly requested alongside custom fields. */
export const STANDARD_FIELDS = [
  'id', 'name', 'default_code', 'barcode', 'active', 'type',
  'categ_id', 'list_price', 'standard_price', 'qty_available',
] as const;

/** Default field list for product queries (excludes image_1920 for performance). */
export const DEFAULT_PRODUCT_FIELDS = [
  ...STANDARD_FIELDS,
  ...CUSTOM_FIELDS,
] as const;

