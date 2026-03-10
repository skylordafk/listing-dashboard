// Odoo product → eBay listing payload mapper.
// Port of ebay_field_mapper.py.

import { cleanProcessorString } from './value-matcher.js';

import type { OdooProduct, OdooImage } from '@ld/odoo-sdk';
import { xmlEscape } from '@ld/ebay-client';
import type { ListingData } from './normalizer.js';
import type { LegacyItemSpecific } from './normalizer.js';
import { EBAY_CONDITIONS, CONDITION_LABEL_TO_ID, parseEnrichmentBlob } from '@ld/catalog';

// ── Constants ────────────────────────────────────────────────────────

export const EBAY_CATEGORY_LAPTOP = '177';

export const EBAY_CONDITION_USED = String(EBAY_CONDITIONS.used);
export const EBAY_CONDITION_REFURBISHED_SELLER = String(EBAY_CONDITIONS.seller_refurbished);
export const EBAY_CONDITION_REFURBISHED_CERTIFIED = String(EBAY_CONDITIONS.certified_refurbished);
export const EBAY_CONDITION_NEW = String(EBAY_CONDITIONS.new);

export const STORAGE_TYPE_DISPLAY: Record<string, string> = {
  nvme: 'NVMe (Non-Volatile Memory Express)',
  ssd: 'SSD (Solid State Drive)',
  hdd: 'HDD (Hard Disk Drive)',
  hdd_ssd: 'HDD + SSD',
  emmc: 'eMMC',
  sshd: 'SSHD (Solid State Hybrid Drive)',
};

export const RAM_DISPLAY: Record<string, string> = {
  '1gb': '1 GB', '2gb': '2 GB', '4gb': '4 GB',
  '8gb': '8 GB', '16gb': '16 GB', '24gb': '24 GB',
  '32gb': '32 GB', '64gb': '64 GB', '128gb': '128 GB',
};

export const GRAPHICS_TYPE_DISPLAY: Record<string, string> = {
  integrated: 'Integrated/On-Board Graphics',
  dedicated: 'Dedicated/Discrete',
};

export const LAPTOP_TYPE_DISPLAY: Record<string, string> = {
  notebook: 'Notebook/Laptop',
  convertible: '2 in 1 Laptop',
};

// ── Field Accessor ──────────────────────────────────────────────────

function getField(product: OdooProduct, field: keyof OdooProduct): string | null {
  const val = product[field];
  if (val === null || val === undefined || val === false || val === '') return null;
  if (typeof val === 'string' && val.trim() === '') return null;
  return String(val);
}

// ── Title Builder ───────────────────────────────────────────────────

function shortenProcessor(processor: string): string {
  // Use the shared processor cleaner, then strip vendor prefix for titles
  let p = cleanProcessorString(processor);
  for (const prefix of ['Intel ', 'AMD ', 'Apple ']) {
    if (p.startsWith(prefix)) p = p.slice(prefix.length);
  }
  return p;
}

function buildTitle(product: OdooProduct): string {
  const parts: string[] = [];

  const brand = getField(product, 'x_brand');
  if (brand) {
    const upper = brand.trim().toUpperCase();
    const capitalize = ['LENOVO', 'DELL', 'HP', 'ASUS', 'ACER', 'APPLE', 'MICROSOFT', 'TOSHIBA', 'SAMSUNG'];
    parts.push(capitalize.includes(upper) ? brand.trim().charAt(0).toUpperCase() + brand.trim().slice(1).toLowerCase() : brand.trim());
  }

  const series = getField(product, 'x_series');
  if (series) parts.push(series);

  const model = getField(product, 'x_model_name');
  if (model) parts.push(model);

  const processor = getField(product, 'x_processor');
  if (processor) parts.push(shortenProcessor(processor));

  const ram = getField(product, 'x_ram_size');
  if (ram) parts.push(RAM_DISPLAY[ram] ?? ram.toUpperCase());

  const storage = getField(product, 'x_storage_capacity');
  const storageType = getField(product, 'x_storage_type');
  if (storage) {
    let storageStr = storage;
    if (storageType) {
      let typeShort = storageType.toUpperCase();
      if (typeShort === 'NVME') typeShort = 'NVMe SSD';
      else if (typeShort === 'HDD_SSD') typeShort = 'HDD+SSD';
      storageStr = `${storage} ${typeShort}`;
    }
    parts.push(storageStr);
  }

  const screen = getField(product, 'x_screen_size');
  if (screen) {
    parts.push(screen.toLowerCase().includes('in') ? screen : `${screen}"`);
  }

  let title = parts.join(' ');
  if (title.length > 80) title = title.slice(0, 77) + '...';
  return title;
}

// ── Enrichment-Aware Item Specifics ─────────────────────────────────

function buildEnrichedItemSpecifics(product: OdooProduct): LegacyItemSpecific[] | null {
  const blob = parseEnrichmentBlob(product.x_ebay_item_specifics);
  if (!blob) return null;

  const specifics: LegacyItemSpecific[] = [];
  for (const [name, value] of Object.entries(blob.specifics)) {
    if (value) specifics.push({ Name: name, Value: value });
  }
  return specifics;
}

// ── Item Specifics Builder (hardcoded laptop fallback) ──────────────

function buildItemSpecifics(product: OdooProduct): LegacyItemSpecific[] {
  const specifics: LegacyItemSpecific[] = [];
  const add = (name: string, value: string | null) => {
    if (value) specifics.push({ Name: name, Value: value });
  };

  add('Brand', getField(product, 'x_brand'));
  add('Model', getField(product, 'x_model_name'));
  add('Series', getField(product, 'x_series'));
  const rawProcessor = getField(product, 'x_processor');
  if (rawProcessor) add('Processor', cleanProcessorString(rawProcessor));
  add('Processor Speed', getField(product, 'x_processor_speed'));

  const ram = getField(product, 'x_ram_size');
  if (ram) add('RAM Size', RAM_DISPLAY[ram] ?? ram.toUpperCase());

  const storageCapacity = getField(product, 'x_storage_capacity');
  const storageType = getField(product, 'x_storage_type');
  const isSsd = storageType && ['ssd', 'nvme'].includes(storageType.toLowerCase());

  // eBay uses separate "Hard Drive Capacity" and "SSD Capacity" aspects
  if (storageCapacity) {
    add('Hard Drive Capacity', storageCapacity);
    if (isSsd) add('SSD Capacity', storageCapacity);
  }

  if (storageType) add('Storage Type', STORAGE_TYPE_DISPLAY[storageType] ?? storageType);

  add('GPU', getField(product, 'x_gpu'));

  const graphicsType = getField(product, 'x_graphics_type');
  if (graphicsType) add('Graphics Processing Type', GRAPHICS_TYPE_DISPLAY[graphicsType] ?? graphicsType);

  add('Screen Size', getField(product, 'x_screen_size'));
  add('Maximum Resolution', getField(product, 'x_max_resolution'));

  const connectivity = getField(product, 'x_connectivity');
  if (connectivity) {
    for (const conn of connectivity.split(',')) {
      const trimmed = conn.trim();
      if (trimmed) specifics.push({ Name: 'Connectivity', Value: trimmed });
    }
  }

  const features = getField(product, 'x_features');
  if (features) {
    for (const feat of features.split(',')) {
      const trimmed = feat.trim();
      if (trimmed) specifics.push({ Name: 'Features', Value: trimmed });
    }
  }

  const laptopType = getField(product, 'x_laptop_type');
  if (laptopType) add('Type', LAPTOP_TYPE_DISPLAY[laptopType] ?? laptopType);

  add('Operating System', getField(product, 'x_operating_system'));
  add('Color', getField(product, 'x_color'));

  const releaseYear = getField(product, 'x_release_year');
  if (releaseYear) add('Release Year', releaseYear);

  return specifics;
}

// ── Fallback Description ────────────────────────────────────────────

function buildDescription(product: OdooProduct): string {
  const brand = xmlEscape(getField(product, 'x_brand') ?? 'N/A');
  const model = xmlEscape(getField(product, 'x_model_name') ?? 'N/A');
  const series = xmlEscape(getField(product, 'x_series') ?? '');
  const processor = xmlEscape(getField(product, 'x_processor') ?? 'N/A');
  const speed = xmlEscape(getField(product, 'x_processor_speed') ?? '');
  const ram = getField(product, 'x_ram_size');
  const ramDisplay = ram ? (RAM_DISPLAY[ram] ?? ram.toUpperCase()) : 'N/A';
  const storage = xmlEscape(getField(product, 'x_storage_capacity') ?? 'N/A');
  const storageType = getField(product, 'x_storage_type');
  const storageTypeDisplay = storageType ? (STORAGE_TYPE_DISPLAY[storageType] ?? '') : '';
  const gpu = xmlEscape(getField(product, 'x_gpu') ?? 'N/A');
  const graphicsType = getField(product, 'x_graphics_type');
  const graphicsDisplay = graphicsType ? (GRAPHICS_TYPE_DISPLAY[graphicsType] ?? '') : '';
  const screen = xmlEscape(getField(product, 'x_screen_size') ?? 'N/A');
  const resolution = xmlEscape(getField(product, 'x_max_resolution') ?? 'N/A');
  const connectivity = xmlEscape(getField(product, 'x_connectivity') ?? 'N/A');
  const features = xmlEscape(getField(product, 'x_features') ?? 'N/A');

  const titleLine = `${brand} ${series} ${model}`.trim();

  return `<div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto;">
  <h2 style="color: #333;">${titleLine}</h2>
  <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
    <tr style="background: #f5f5f5;"><td style="padding: 8px 12px; border: 1px solid #ddd; font-weight: bold; width: 200px;">Brand</td><td style="padding: 8px 12px; border: 1px solid #ddd;">${brand}</td></tr>
    <tr><td style="padding: 8px 12px; border: 1px solid #ddd; font-weight: bold;">Model</td><td style="padding: 8px 12px; border: 1px solid #ddd;">${model}</td></tr>
    <tr style="background: #f5f5f5;"><td style="padding: 8px 12px; border: 1px solid #ddd; font-weight: bold;">Processor</td><td style="padding: 8px 12px; border: 1px solid #ddd;">${processor}${speed ? ' @ ' + speed : ''}</td></tr>
    <tr><td style="padding: 8px 12px; border: 1px solid #ddd; font-weight: bold;">RAM</td><td style="padding: 8px 12px; border: 1px solid #ddd;">${ramDisplay}</td></tr>
    <tr style="background: #f5f5f5;"><td style="padding: 8px 12px; border: 1px solid #ddd; font-weight: bold;">Storage</td><td style="padding: 8px 12px; border: 1px solid #ddd;">${storage}${storageTypeDisplay ? ' ' + storageTypeDisplay : ''}</td></tr>
    <tr><td style="padding: 8px 12px; border: 1px solid #ddd; font-weight: bold;">Graphics</td><td style="padding: 8px 12px; border: 1px solid #ddd;">${gpu}${graphicsDisplay ? ' (' + graphicsDisplay + ')' : ''}</td></tr>
    <tr style="background: #f5f5f5;"><td style="padding: 8px 12px; border: 1px solid #ddd; font-weight: bold;">Screen Size</td><td style="padding: 8px 12px; border: 1px solid #ddd;">${screen}</td></tr>
    <tr><td style="padding: 8px 12px; border: 1px solid #ddd; font-weight: bold;">Resolution</td><td style="padding: 8px 12px; border: 1px solid #ddd;">${resolution}</td></tr>
    <tr style="background: #f5f5f5;"><td style="padding: 8px 12px; border: 1px solid #ddd; font-weight: bold;">Connectivity</td><td style="padding: 8px 12px; border: 1px solid #ddd;">${connectivity}</td></tr>
    <tr><td style="padding: 8px 12px; border: 1px solid #ddd; font-weight: bold;">Features</td><td style="padding: 8px 12px; border: 1px solid #ddd;">${features}</td></tr>
  </table>
  <div style="margin: 20px 0; padding: 15px; background: #f9f9f9; border-left: 4px solid #4CAF50;">
    <h3 style="margin: 0 0 10px 0; color: #333;">Condition</h3>
    <p style="margin: 0; color: #666;">This laptop has been tested and is fully functional. It may show signs of prior use including minor cosmetic wear. No operating system is installed.</p>
  </div>
  <div style="margin: 20px 0; padding: 15px; background: #fff3cd; border-left: 4px solid #ffc107;">
    <h3 style="margin: 0 0 10px 0; color: #333;">What's Included</h3>
    <ul style="margin: 0; padding-left: 20px; color: #666;">
      <li>Laptop only</li>
      <li>No charger, accessories, or original packaging unless pictured</li>
    </ul>
  </div>
</div>`;
}

// ── Price Calculator ────────────────────────────────────────────────

function calculatePrice(product: OdooProduct): number {
  if (product.list_price && product.list_price > 0) {
    return Math.round(product.list_price * 100) / 100;
  }
  if (product.standard_price && product.standard_price > 0) {
    return Math.round(product.standard_price * 1.5 * 100) / 100;
  }
  return 0;
}

// ── Main Export ──────────────────────────────────────────────────────

export function productToListing(product: OdooProduct, images?: OdooImage[]): ListingData {
  const title = buildTitle(product);
  const descriptionHtml = buildDescription(product);
  const price = calculatePrice(product);

  // Category: use enrichment if available, else fallback to laptop
  const categoryId = product.x_ebay_category_id || EBAY_CATEGORY_LAPTOP;

  // Condition: use x_condition mapping if available, else fallback to Used
  let conditionId: string = EBAY_CONDITION_USED;
  if (product.x_condition) {
    const mapped = CONDITION_LABEL_TO_ID[product.x_condition];
    if (mapped !== undefined) {
      conditionId = String(mapped);
    }
  }

  // Item specifics: try enrichment blob first, fall back to hardcoded mapper
  const itemSpecifics = buildEnrichedItemSpecifics(product) ?? buildItemSpecifics(product);

  const listing: ListingData = {
    title,
    category_id: categoryId,
    condition_id: conditionId,
    condition_description: '',
    price,
    currency: 'USD',
    quantity: 1,
    listing_duration: 'GTC',
    item_specifics: itemSpecifics,
    description_html: descriptionHtml,
    image_urls: [],
    shipping_type: 'Flat',
    shipping_cost: 0.0,
    returns_accepted: true,
    return_days: 30,
    dispatch_days: 3,
    country: 'US',
    location: 'United States',
  };

  if (product.default_code) {
    listing.sku = String(product.default_code);
  }

  if (images && images.length > 0) {
    listing.image_count = images.length;
  }

  return listing;
}
