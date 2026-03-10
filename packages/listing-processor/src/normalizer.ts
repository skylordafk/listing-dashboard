// eBay listing normalization — title, description, item specifics.
// Port of app.py normalization engine (constants + functions).

import {
  matchValue,
  matchValueOrKeep,
  cleanProcessorString,
  resolveSpecNameForCategory,
  findSpecValueByAspectName,
  NAME_ALIAS_GROUPS,
} from './value-matcher.js';

// ── Constants ────────────────────────────────────────────────────────

export const TITLE_MAX_CHARS = 80;
export const TITLE_MIN_RECOMMENDED_CHARS = 65;
export const DESCRIPTION_MIN_RECOMMENDED_TEXT_CHARS = 350;
export const MIN_RECOMMENDED_ITEM_SPECIFICS = 6;

export const PLACEHOLDER_SPECIFIC_VALUES = new Set([
  'n/a', 'na', 'none', 'unknown', 'not applicable', 'null', '-', '--',
]);

export const EBAY_177_ALLOWED_SPECIFICS = new Set([
  'Brand', 'Model', 'Series', 'Type', 'Processor', 'Processor Speed',
  'RAM Size', 'Storage Capacity', 'Hard Drive Capacity', 'SSD Capacity',
  'Storage Type', 'GPU', 'Graphics Processing Type', 'Screen Size',
  'Maximum Resolution', 'Connectivity', 'Features', 'Operating System',
  'Color', 'Release Year', 'Most Suitable For', 'MPN',
]);

export const SPECIFIC_NAME_SYNONYMS: Record<string, string> = {
  'cpu': 'Processor',
  'processor model': 'Processor',
  'processor type': 'Processor',
  'memory': 'RAM Size',
  'ram': 'RAM Size',
  'hard drive capacity': 'Hard Drive Capacity',
  'hdd capacity': 'Hard Drive Capacity',
  'ssd capacity': 'SSD Capacity',
  'storage capacity': 'Hard Drive Capacity',
  'graphics': 'GPU',
  'graphics card': 'GPU',
  'video card': 'GPU',
  'screen': 'Screen Size',
  'resolution': 'Maximum Resolution',
  'display resolution': 'Maximum Resolution',
  'os': 'Operating System',
  'operating system edition': 'Operating System',
};

export const CANONICAL_RAM_VALUES: Record<string, string> = {
  '4gb': '4 GB', '8gb': '8 GB', '16gb': '16 GB', '24gb': '24 GB',
  '32gb': '32 GB', '64gb': '64 GB', '128gb': '128 GB',
};

export const CANONICAL_STORAGE_TYPE_VALUES: Record<string, string> = {
  'ssd': 'SSD', 'nvme': 'NVMe', 'nvme ssd': 'NVMe',
  'nvme (non-volatile memory express)': 'NVMe',
  'hdd': 'HDD', 'hdd (hard disk drive)': 'HDD',
  'emmc': 'eMMC', 'hdd+ssd': 'HDD + SSD', 'hdd + ssd': 'HDD + SSD',
  'sshd': 'SSHD', 'ssd (solid state drive)': 'SSD',
  'sshd (solid state hybrid drive)': 'SSHD',
};

export const CANONICAL_GRAPHICS_TYPE_VALUES: Record<string, string> = {
  'integrated': 'Integrated/On-Board Graphics',
  'integrated/on-board graphics': 'Integrated/On-Board Graphics',
  'dedicated': 'Dedicated/Discrete Graphics',
  'dedicated/discrete': 'Dedicated/Discrete Graphics',
  'dedicated/discrete graphics': 'Dedicated/Discrete Graphics',
};

export const CANONICAL_TYPE_VALUES: Record<string, string> = {
  'notebook': 'Notebook/Laptop',
  'laptop': 'Notebook/Laptop',
  'notebook/laptop': 'Notebook/Laptop',
  '2 in 1 laptop': '2-in-1 Laptop/Tablet',
  '2-in-1': '2-in-1 Laptop/Tablet',
  'convertible': '2-in-1 Laptop/Tablet',
};

export const CANONICAL_OS_VALUES: Record<string, string> = {
  'none': 'Not Included', 'no os': 'Not Included', 'not included': 'Not Included',
  'windows 11 pro': 'Windows 11 Pro', 'windows 11 home': 'Windows 11 Home',
  'windows 10 pro': 'Windows 10 Pro', 'windows 10 home': 'Windows 10 Home',
  'chrome os': 'Chrome OS', 'macos': 'macOS', 'linux': 'Linux',
};

// ── Text Utilities ──────────────────────────────────────────────────

export function cleanText(value: unknown): string {
  if (value == null) return '';
  let text = String(value).replace(/\x00/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

export function truncateReadable(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let clipped = text.slice(0, limit).replace(/[ ,;:\-|/]+$/, '');
  const lastSpace = clipped.lastIndexOf(' ');
  if (lastSpace >= Math.max(0, limit - 18)) {
    clipped = clipped.slice(0, lastSpace);
  }
  return clipped.replace(/[ ,;:\-|/]+$/, '');
}

// ── Specific Name/Value Normalization ───────────────────────────────

export function normalizeSpecificName(
  name: string,
  allowedNames?: Set<string>,
): string {
  const base = cleanText(name);
  if (!base) return '';
  const key = base.toLowerCase();

  // 1. Check direct synonym mapping
  if (key in SPECIFIC_NAME_SYNONYMS) {
    const canonical = SPECIFIC_NAME_SYNONYMS[key]!;
    // If we have category-specific allowed names, verify the canonical is allowed
    if (allowedNames) {
      const resolved = resolveSpecNameForCategory(canonical, allowedNames);
      if (resolved !== canonical || allowedNames.has(resolved)) return resolved;
    }
    return canonical;
  }

  const pool = allowedNames ?? EBAY_177_ALLOWED_SPECIFICS;

  // 2. Direct case-insensitive match
  for (const allowed of pool) {
    if (key === allowed.toLowerCase()) return allowed;
  }

  // 3. Alias group resolution (bidirectional)
  if (allowedNames) {
    const resolved = resolveSpecNameForCategory(base, allowedNames);
    if (resolved.toLowerCase() !== key) return resolved;
  }

  return '';
}

export function normalizeSpecificValue(
  name: string,
  value: string,
  valueOptionsByName?: Record<string, string[]>,
): string {
  const v = cleanText(value);
  if (!v) return '';
  const low = v.toLowerCase();

  // Smart-match against category-specific value options (eBay allowed values)
  if (valueOptionsByName) {
    const options = valueOptionsByName[name];
    if (options && options.length > 0) {
      const match = matchValue(v, options, name);
      if (match && match.confidence >= 0.7) return match.value;
    }
  }

  if (name === 'RAM Size') {
    const compact = low.replace(/ /g, '');
    if (compact in CANONICAL_RAM_VALUES) return CANONICAL_RAM_VALUES[compact]!;
    const m = low.match(/(\d+)\s*gb/);
    if (m) return `${m[1]} GB`;
  }

  if (name === 'Storage Capacity') {
    const m = low.match(/(\d+(?:\.\d+)?)\s*(tb|gb)/);
    if (m) {
      const num = parseFloat(m[1]!);
      const unit = m[2]!.toUpperCase();
      if (unit === 'TB' && Number.isInteger(num)) return `${num} TB`;
      if (unit === 'GB' && Number.isInteger(num)) return `${num} GB`;
      return `${num} ${unit}`;
    }
  }

  if (name === 'Storage Type') return CANONICAL_STORAGE_TYPE_VALUES[low] ?? v;
  if (name === 'Graphics Processing Type') return CANONICAL_GRAPHICS_TYPE_VALUES[low] ?? v;
  if (name === 'Type') return CANONICAL_TYPE_VALUES[low] ?? v;
  if (name === 'Operating System') return CANONICAL_OS_VALUES[low] ?? v;

  if (name === 'Screen Size') {
    const m = low.match(/(\d+(?:\.\d+)?)/);
    if (m) {
      const num = parseFloat(m[1]!);
      return `${num} in`;
    }
  }

  return v;
}

// ── Title Normalization ─────────────────────────────────────────────

export function normalizeTitle(title: string): string {
  let t = cleanText(title);
  t = t.replace(/[<>]+/g, ' ');
  t = cleanText(t);
  if (!t) return 'Untitled Listing';
  return truncateReadable(t, TITLE_MAX_CHARS);
}

// ── Description Sanitization ────────────────────────────────────────

export function sanitizeDescriptionHtml(html: string): string {
  let text = (html ?? '').replace(/\x00/g, '');
  if (!text) return '';
  text = text.replace(/<script\b[^>]*>.*?<\/script>/gis, '');
  text = text.replace(/<style\b[^>]*>.*?<\/style>/gis, '');
  text = text.replace(/<(iframe|object|embed|form|input|button|meta|link)\b[^>]*>.*?<\/\1>/gis, '');
  text = text.replace(/<(iframe|object|embed|input|meta|link)\b[^>]*?\/?>/gis, '');
  text = text.replace(/\son\w+\s*=\s*(["']).*?\1/gis, '');
  text = text.replace(/\s(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gis, '');
  return text.trim();
}

// ── Item Specifics Normalization ────────────────────────────────────

// Re-export the catalog's canonical ItemSpecific type
export type { ItemSpecific } from '@ld/catalog';

/**
 * Legacy item-specific shape used throughout listing-dashboard.
 * Capital-letter keys (Name/Value) match the eBay Trading API XML format.
 * Phase 2 will migrate consumers to the catalog's lowercase shape.
 */
export interface LegacyItemSpecific {
  Name: string;
  Value: string;
}

export function normalizeItemSpecifics(
  itemSpecifics: unknown[],
  allowedNames?: Set<string>,
  valueOptionsByName?: Record<string, string[]>,
  multiValueNames?: Set<string>,
): LegacyItemSpecific[] {
  if (!Array.isArray(itemSpecifics)) return [];

  const normalized: LegacyItemSpecific[] = [];
  const seen = new Set<string>();

  for (const raw of itemSpecifics) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const name = normalizeSpecificName(String(r.Name ?? ''), allowedNames);
    const value = cleanText(r.Value);
    if (!name || !value) continue;
    if (PLACEHOLDER_SPECIFIC_VALUES.has(value.toLowerCase())) continue;

    const truncatedName = truncateReadable(name, 65);

    // Only split on delimiters for multi-value aspects.
    // When no multiValueNames metadata is provided (e.g. hardcoded laptop path),
    // fall back to splitting everything as a safety net for backward compat.
    const isMultiValue = multiValueNames
      ? multiValueNames.has(name)
      : true; // no metadata → split as before
    const parts = isMultiValue
      ? value.split(/[;,]/).map(s => s.trim()).filter(Boolean)
      : [value];

    for (const part of parts) {
      const normalizedValue = normalizeSpecificValue(name, part, valueOptionsByName);
      if (!normalizedValue) continue;

      const entry: LegacyItemSpecific = {
        Name: truncatedName,
        Value: truncateReadable(normalizedValue, 65),
      };

      const key = `${entry.Name.toLowerCase()}|${entry.Value.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push(entry);
    }
  }

  return normalized;
}

// ── Extract Visible Text ────────────────────────────────────────────

export function extractVisibleText(html: string): string {
  const text = (html ?? '').replace(/<[^>]+>/gi, ' ');
  return cleanText(text);
}

// ── Listing Data Types ──────────────────────────────────────────────

export interface ListingData {
  title: string;
  sku?: string;
  category_id?: string;
  condition_id?: number | string;
  condition_description?: string;
  price: number;
  currency?: string;
  quantity?: number;
  listing_duration?: string;
  item_specifics: LegacyItemSpecific[];
  description_html: string;
  image_urls?: string[];
  image_count?: number;
  shipping_type?: string;
  shipping_cost?: number;
  returns_accepted?: boolean;
  return_days?: number;
  dispatch_days?: number;
  country?: string;
  location?: string;
  [key: string]: unknown;
}

// ── Finalize Listing Data ───────────────────────────────────────────

export function finalizeListingData(
  listingData: ListingData,
  categoryOptions?: Record<string, string[]>,
  defaultConditionDescription?: string,
  multiValueNames?: Set<string>,
): ListingData {
  const data = { ...listingData };

  data.title = normalizeTitle(data.title);

  if (data.price != null && data.price !== ('' as unknown as number)) {
    try {
      data.price = Math.round(Number(data.price) * 100) / 100;
    } catch { /* keep as-is */ }
  }

  if (data.sku) {
    data.sku = cleanText(data.sku).slice(0, 50);
  }

  if (data.condition_description) {
    data.condition_description = cleanText(data.condition_description);
  } else if (defaultConditionDescription) {
    data.condition_description = defaultConditionDescription;
  }

  data.description_html = sanitizeDescriptionHtml(data.description_html ?? '');

  const categoryId = String(data.category_id ?? '177');
  const allowedNames = new Set(EBAY_177_ALLOWED_SPECIFICS);
  if (categoryOptions) {
    for (const name of Object.keys(categoryOptions)) {
      allowedNames.add(name);
    }
  }

  data.item_specifics = normalizeItemSpecifics(
    data.item_specifics ?? [],
    allowedNames,
    categoryOptions ?? undefined,
    multiValueNames,
  );

  return data;
}

// ── Quality Warnings ────────────────────────────────────────────────

export function listingQualityWarnings(listingData: ListingData): string[] {
  const warnings: string[] = [];
  const title = listingData.title ?? '';
  const descText = extractVisibleText(listingData.description_html ?? '');
  const specifics = listingData.item_specifics ?? [];

  if (title.length < TITLE_MIN_RECOMMENDED_CHARS) {
    warnings.push(
      `Title is only ${title.length} chars. Aim for ${TITLE_MIN_RECOMMENDED_CHARS}-${TITLE_MAX_CHARS} for stronger search coverage.`
    );
  }

  if (descText.length < DESCRIPTION_MIN_RECOMMENDED_TEXT_CHARS) {
    warnings.push(
      `Description is short (${descText.length} visible chars). Add more verified product details to improve conversion.`
    );
  }

  if (specifics.length < MIN_RECOMMENDED_ITEM_SPECIFICS) {
    warnings.push(
      `Only ${specifics.length} item specifics found. Add more specifics to improve listing completeness.`
    );
  }

  try {
    if (Number(listingData.price ?? 0) <= 0) {
      warnings.push('Price is zero or missing.');
    }
  } catch {
    warnings.push('Price format is invalid.');
  }

  return warnings;
}

// ── Form Override Application ───────────────────────────────────────

export function applyListingFormOverrides(
  listingData: ListingData,
  form: Record<string, string>,
  categoryOptions?: Record<string, string[]>,
  defaultConditionDescription?: string,
  multiValueNames?: Set<string>,
): ListingData {
  const data = { ...listingData };

  if (form.title) data.title = form.title.slice(0, TITLE_MAX_CHARS);
  if (form.price) {
    try { data.price = parseFloat(form.price); } catch { /* ignore */ }
  }
  if (form.condition_description) data.condition_description = form.condition_description;
  if (form.condition_id) {
    try { data.condition_id = parseInt(form.condition_id, 10); } catch { /* ignore */ }
  }
  if (form.sku) data.sku = form.sku.slice(0, 50);
  if (form.category_id) data.category_id = form.category_id;
  if (form.description_html) data.description_html = form.description_html;

  if (form.item_specifics_json) {
    try {
      const parsed = JSON.parse(form.item_specifics_json);
      if (Array.isArray(parsed)) {
        data.item_specifics = parsed;
      }
    } catch (err) {
      console.warn('Invalid item_specifics_json from form:', err);
    }
  }

  // Also check for individual spec fields from hidden form inputs
  if (form.spec_count) {
    const count = parseInt(form.spec_count, 10);
    if (count > 0) {
      const specs: LegacyItemSpecific[] = [];
      for (let i = 0; i < count; i++) {
        const name = form[`spec_name_${i}`];
        const value = form[`spec_value_${i}`];
        if (name && value) specs.push({ Name: name, Value: value });
      }
      if (specs.length > 0) data.item_specifics = specs;
    }
  }

  return finalizeListingData(data, categoryOptions, defaultConditionDescription, multiValueNames);
}

// Re-export value matcher utilities
export { matchValue, matchValueOrKeep, cleanProcessorString, resolveSpecNameForCategory, findSpecValueByAspectName, NAME_ALIAS_GROUPS } from "./value-matcher.js";
