// AI-powered listing title and description generator.
// Port of ai_generator.py — OpenAI API with structured output + vision.

import type { OdooProduct } from '@ld/odoo-sdk';
import {
  loadAiConfig, saveAiConfig,
  DEFAULT_TITLE_PROMPT, DEFAULT_DESCRIPTION_PROMPT,
  DEFAULT_CONDITION_NOTES, DEFAULT_SHIPPING_INFO, DEFAULT_RETURNS_POLICY,
  type AiConfig,
} from './config.js';
import type { OdooImage } from './field-mapper.js';

// ── Category Context ────────────────────────────────────────────────

export interface CategoryContext {
  categoryId: string;
  categoryName: string;           // e.g., "Laptops & Netbooks"
  requiredAspects: string[];      // aspect names that are required
  recommendedAspects: string[];   // aspect names that are recommended
  aspectValues: Record<string, string[]>; // name → allowed values (top values only)
}

// ── OpenAI Schemas ──────────────────────────────────────────────────

const TITLE_RESPONSE_SCHEMA = {
  name: 'listing_titles',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      titles: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            generatedTitle: { type: 'string', description: 'SEO-optimized eBay listing title, 70-80 characters' },
            chars: { type: 'integer', description: 'Character count of the generated title' },
            strategy: { type: 'string', description: 'Title strategy (full-spec, model-forward, condition-prominent)' },
          },
          required: ['generatedTitle', 'chars', 'strategy'],
          additionalProperties: false,
        },
        description: 'Array of title options with character counts and strategies',
      },
    },
    required: ['titles'],
    additionalProperties: false,
  },
};

const DESCRIPTION_RESPONSE_SCHEMA = {
  name: 'listing_description',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      html: { type: 'string', description: 'Complete HTML description for eBay listing' },
      highlights: {
        type: 'array',
        items: { type: 'string' },
        description: '3-5 key selling points extracted from the product data',
      },
    },
    required: ['html', 'highlights'],
    additionalProperties: false,
  },
};

const MAX_DESCRIPTION_IMAGES = 2;

/** Max allowed values to include per aspect in the prompt (avoid token bloat). */
const MAX_ASPECT_VALUES_IN_PROMPT = 15;


/** Map our Odoo field labels to eBay aspect name aliases for classification. */
const LABEL_TO_ASPECT_ALIASES: Record<string, string[]> = {
  'brand': ['brand'],
  'series': ['series'],
  'model': ['model'],
  'processor': ['processor', 'processor model'],
  'processor speed': ['processor speed'],
  'ram': ['ram', 'ram size', 'maximum ram supported'],
  'storage capacity': ['storage capacity', 'hard drive capacity', 'ssd capacity'],
  'storage type': ['storage type', 'hard drive type'],
  'gpu': ['gpu', 'graphics processing type'],
  'graphics type': ['graphics type', 'graphics processing type'],
  'screen size': ['screen size'],
  'resolution': ['resolution', 'max screen resolution', 'maximum resolution'],
  'operating system': ['operating system', 'operating system edition'],
  'color': ['color'],
  'condition': ['condition'],
  'release year': ['release year'],
  'type': ['type'],
};

const STRUCTURED_OUTPUT_MODELS = new Set([
  'gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano',
  'gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
]);

// ── Helpers ─────────────────────────────────────────────────────────

function cleanText(value: unknown): string {
  if (value == null) return '';
  return String(value).replace(/\x00/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncateReadable(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let clipped = text.slice(0, limit).replace(/[ ,;:\-|/]+$/, '');
  const lastSpace = clipped.lastIndexOf(' ');
  if (lastSpace >= Math.max(0, limit - 18)) clipped = clipped.slice(0, lastSpace);
  return clipped.replace(/[ ,;:\-|/]+$/, '');
}

function normalizeGeneratedTitle(title: string): string {
  let t = cleanText(title).replace(/[<>]+/g, ' ');
  t = cleanText(t);
  return t ? truncateReadable(t, 80) : '';
}

function sanitizeGeneratedDescription(html: string): string {
  let text = (html ?? '').replace(/\x00/g, '');
  if (!text) return '';
  text = text.replace(/<script\b[^>]*>.*?<\/script>/gis, '');
  text = text.replace(/<style\b[^>]*>.*?<\/style>/gis, '');
  text = text.replace(/\son\w+\s*=\s*(["']).*?\1/gis, '');
  text = text.replace(/\s(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gis, '');
  return text.trim();
}

function stripHtml(text: string): string {
  return (text ?? '').replace(/<[^>]+>/gi, ' ').trim();
}

function esc(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isNonemptyValue(value: unknown): boolean {
  if (value == null) return false;
  const s = String(value).trim();
  if (!s) return false;
  return !['n/a', 'na', 'none', 'unknown', 'null', '-'].includes(s.toLowerCase());
}

function fmtStorageType(value: unknown): string {
  const low = String(value ?? '').trim().toLowerCase();
  const mapping: Record<string, string> = {
    nvme: 'NVMe', ssd: 'SSD', hdd: 'HDD', emmc: 'eMMC', hdd_ssd: 'HDD + SSD',
  };
  return mapping[low] ?? String(value ?? '');
}

function getField(product: OdooProduct, field: keyof OdooProduct): unknown {
  const val = product[field];
  if (val === false || val === null || val === undefined) return null;
  return val;
}

// ── Product Formatting for Prompts ──────────────────────────────────

function formatProductForPrompt(product: OdooProduct, categoryContext?: CategoryContext): string {
  const productType = categoryContext?.categoryName ?? 'LAPTOP';
  const lines: string[] = [`${productType.toUpperCase()} SPECIFICATIONS:`];

  const name = product.name || (product as unknown as Record<string, unknown>).display_name;
  if (name) lines.push(`- Product Name/SKU: ${name}`);

  const fieldLabels: Array<[keyof OdooProduct, string]> = [
    ['x_brand', 'Brand'], ['x_series', 'Series'], ['x_model_name', 'Model'],
    ['x_processor', 'Processor'], ['x_processor_speed', 'Processor Speed'],
    ['x_ram_size', 'RAM'], ['x_storage_capacity', 'Storage Capacity'],
    ['x_storage_type', 'Storage Type'], ['x_gpu', 'GPU'],
    ['x_graphics_type', 'Graphics Type'], ['x_screen_size', 'Screen Size'],
    ['x_max_resolution', 'Resolution'], ['x_operating_system', 'Operating System'],
    ['x_connectivity', 'Connectivity'], ['x_features', 'Features'],
    ['x_color', 'Color'], ['x_condition', 'Condition'],
    ['x_release_year', 'Release Year'], ['x_laptop_type', 'Type'],
  ];

  if (categoryContext) {
    // Organize specs: required first, then recommended, then others
    const requiredSet = new Set(categoryContext.requiredAspects.map(a => a.toLowerCase()));
    const recommendedSet = new Set(categoryContext.recommendedAspects.map(a => a.toLowerCase()));

    const requiredFields: Array<[keyof OdooProduct, string]> = [];
    const recommendedFields: Array<[keyof OdooProduct, string]> = [];
    const otherFields: Array<[keyof OdooProduct, string]> = [];

    for (const [field, label] of fieldLabels) {
      const aliases = LABEL_TO_ASPECT_ALIASES[label.toLowerCase()] ?? [label.toLowerCase()];
      if (aliases.some(a => requiredSet.has(a))) requiredFields.push([field, label]);
      else if (aliases.some(a => recommendedSet.has(a))) recommendedFields.push([field, label]);
      else otherFields.push([field, label]);
    }

    // Emit required specs first
    if (requiredFields.length > 0) {
      lines.push('', '  [REQUIRED by eBay for this category]:');
      for (const [field, label] of requiredFields) {
        const val = formatValue(getField(product, field));
        if (val) lines.push(`- ${label}: ${val}`);
      }
    }

    // Emit recommended specs
    if (recommendedFields.length > 0) {
      lines.push('', '  [RECOMMENDED by eBay]:');
      for (const [field, label] of recommendedFields) {
        const val = formatValue(getField(product, field));
        if (val) lines.push(`- ${label}: ${val}`);
      }
    }

    // Emit remaining specs
    if (otherFields.length > 0) {
      lines.push('', '  [Additional specs]:');
      for (const [field, label] of otherFields) {
        const val = formatValue(getField(product, field));
        if (val) lines.push(`- ${label}: ${val}`);
      }
    }

    // Show eBay required aspects so GPT knows what matters
    lines.push('', 'eBay REQUIRED ASPECTS FOR THIS CATEGORY:');
    for (const aspect of categoryContext.requiredAspects) {
      const vals = categoryContext.aspectValues[aspect];
      if (vals && vals.length > 0) {
        lines.push(`- ${aspect} (allowed values include: ${vals.slice(0, MAX_ASPECT_VALUES_IN_PROMPT).join(', ')})`);
      } else {
        lines.push(`- ${aspect}`);
      }
    }

    if (categoryContext.recommendedAspects.length > 0) {
      lines.push('', 'eBay RECOMMENDED ASPECTS:');
      for (const aspect of categoryContext.recommendedAspects.slice(0, 15)) {
        const vals = categoryContext.aspectValues[aspect];
        if (vals && vals.length > 0) {
          lines.push(`- ${aspect} (values: ${vals.slice(0, 10).join(', ')})`);
        } else {
          lines.push(`- ${aspect}`);
        }
      }
    }
  } else {
    // No category context — flat list (original behavior)
    for (const [field, label] of fieldLabels) {
      const val = formatValue(getField(product, field));
      if (val) lines.push(`- ${label}: ${val}`);
    }
  }

  // Test results
  const testFields: Array<[keyof OdooProduct, string]> = [
    ['x_test_display', 'Display Test'], ['x_test_keyboard', 'Keyboard Test'],
    ['x_test_touchpad', 'Touchpad Test'], ['x_test_speakers', 'Speakers Test'],
    ['x_test_microphone', 'Microphone Test'], ['x_test_webcam', 'Webcam Test'],
    ['x_test_wifi', 'WiFi Test'], ['x_test_bluetooth', 'Bluetooth Test'],
    ['x_test_ports', 'Ports Test'], ['x_test_battery', 'Battery Test'],
  ];
  const testLines: string[] = [];
  for (const [field, label] of testFields) {
    const raw = getField(product, field);
    if (raw && raw !== false) testLines.push(`  - ${label}: PASS`);
  }
  if (testLines.length > 0) {
    lines.push('', 'TEST RESULTS:', ...testLines);
  } else {
    lines.push('', 'NOTE: This unit has not been individually tested yet.');
  }

  // Battery
  const batteryFields: Array<[keyof OdooProduct, string]> = [
    ['x_battery_health', 'Battery Health'], ['x_battery_cycles', 'Battery Cycles'],
  ];
  const batteryLines: string[] = [];
  for (const [field, label] of batteryFields) {
    const val = formatValue(getField(product, field));
    if (val) batteryLines.push(`  - ${label}: ${val}`);
  }
  if (batteryLines.length > 0) {
    lines.push('', 'BATTERY STATUS:', ...batteryLines);
  }

  // Hardware details
  const hwFields: Array<[keyof OdooProduct, string]> = [
    ['x_webcam_resolution', 'Webcam Resolution'], ['x_port_inventory', 'Port Inventory'],
    ['x_has_fingerprint', 'Fingerprint Reader'], ['x_has_touchscreen', 'Touchscreen'],
    ['x_has_backlit_keyboard', 'Backlit Keyboard'],
  ];
  const hwLines: string[] = [];
  for (const [field, label] of hwFields) {
    const val = formatValue(getField(product, field));
    if (val) hwLines.push(`  - ${label}: ${val}`);
  }
  if (hwLines.length > 0) {
    lines.push('', 'HARDWARE DETAILS:', ...hwLines);
  }

  // Condition notes
  for (const [field, label] of [['x_cosmetic_notes', 'Cosmetic Notes'], ['x_functional_notes', 'Functional Notes']] as Array<[keyof OdooProduct, string]>) {
    const val = formatValue(getField(product, field));
    if (val) lines.push('', `${label.toUpperCase()}:`, `  ${val}`);
  }

  return lines.join('\n');
}

function formatValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '' || value === false) return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length > 1 ? String(value[1]) : String(value[0]);
  return String(value);
}

// ── Category Context Prompt Helpers ─────────────────────────────────

/** Apply category-aware placeholder replacements to a system prompt. */
function applyCategoryPlaceholders(prompt: string, categoryContext?: CategoryContext): string {
  const productType = categoryContext?.categoryName ?? 'laptop computers';
  const requiredStr = categoryContext?.requiredAspects?.length
    ? categoryContext.requiredAspects.join(', ')
    : 'Brand, Model, Processor';
  const recommendedStr = categoryContext?.recommendedAspects?.length
    ? categoryContext.recommendedAspects.slice(0, 10).join(', ')
    : 'RAM, Storage, Screen Size';

  return prompt
    .replace(/\{product_type\}/g, productType)
    .replace(/\{required_aspects\}/g, requiredStr)
    .replace(/\{recommended_aspects\}/g, recommendedStr);
}

/** Build a category-specific section for the user prompt (titles). */
function renderCategoryContextForTitles(cc: CategoryContext): string {
  const lines: string[] = [
    `\nEBAY CATEGORY: ${cc.categoryName} (ID: ${cc.categoryId})`,
    '',
    'TITLE OPTIMIZATION — eBay requires these item specifics for this category.',
    'Include as many as possible in the title when the product data has them:',
  ];
  if (cc.requiredAspects.length > 0) {
    lines.push(`  MUST include (when available): ${cc.requiredAspects.join(', ')}`);
  }
  if (cc.recommendedAspects.length > 0) {
    lines.push(`  Include if space allows: ${cc.recommendedAspects.slice(0, 8).join(', ')}`);
  }
  return lines.join('\n');
}

/** Build a category-specific section for the user prompt (descriptions). */
function renderCategoryContextForDescription(cc: CategoryContext): string {
  const lines: string[] = [
    `\nEBAY CATEGORY: ${cc.categoryName} (ID: ${cc.categoryId})`,
    '',
    'Structure the specifications table to prioritize these eBay-required aspects:',
  ];
  if (cc.requiredAspects.length > 0) {
    lines.push(`  Required: ${cc.requiredAspects.join(', ')}`);
  }
  if (cc.recommendedAspects.length > 0) {
    lines.push(`  Recommended: ${cc.recommendedAspects.slice(0, 12).join(', ')}`);
  }
  lines.push('Ensure all required aspects appear in the spec table when data is provided.');
  return lines.join('\n');
}

// ── Fallback Description Builder ───────────────────────────────────

function formatAtAGlance(product: OdooProduct): string[] {
  const items: string[] = [];
  const brand = getField(product, 'x_brand');
  const model = getField(product, 'x_model_name');
  if (isNonemptyValue(brand) || isNonemptyValue(model)) {
    items.push(`${brand || ''} ${model || ''}`.trim());
  }
  const cpu = getField(product, 'x_processor');
  if (isNonemptyValue(cpu)) items.push(String(cpu));
  const ram = getField(product, 'x_ram_size');
  if (isNonemptyValue(ram)) items.push(`${ram} RAM`);
  const storage = getField(product, 'x_storage_capacity');
  const storageType = fmtStorageType(getField(product, 'x_storage_type'));
  if (isNonemptyValue(storage)) items.push(`${storage} ${storageType}`.trim());
  const screen = getField(product, 'x_screen_size');
  if (isNonemptyValue(screen)) items.push(`${screen} display`);
  const resolution = getField(product, 'x_max_resolution');
  if (isNonemptyValue(resolution)) items.push(`Resolution: ${resolution}`);
  const gpu = getField(product, 'x_gpu');
  if (isNonemptyValue(gpu)) items.push(`Graphics: ${gpu}`);
  return items.slice(0, 6);
}

function specRows(product: OdooProduct): Array<[string, string]> {
  const fields: Array<[string, keyof OdooProduct]> = [
    ['Brand', 'x_brand'], ['Series', 'x_series'], ['Model', 'x_model_name'],
    ['Processor', 'x_processor'], ['Processor Speed', 'x_processor_speed'],
    ['RAM', 'x_ram_size'], ['Storage Capacity', 'x_storage_capacity'],
    ['Storage Type', 'x_storage_type'], ['GPU', 'x_gpu'],
    ['Graphics Type', 'x_graphics_type'], ['Screen Size', 'x_screen_size'],
    ['Resolution', 'x_max_resolution'], ['Operating System', 'x_operating_system'],
    ['Connectivity', 'x_connectivity'], ['Features', 'x_features'],
    ['Color', 'x_color'], ['Release Year', 'x_release_year'],
  ];
  const rows: Array<[string, string]> = [];
  for (const [label, field] of fields) {
    const val = getField(product, field);
    if (isNonemptyValue(val)) {
      const display = field === 'x_storage_type' ? fmtStorageType(val) : String(val).trim();
      rows.push([label, display]);
    }
  }
  return rows;
}

function testResultRows(product: OdooProduct): Array<[string, string]> {
  const fields: Array<[string, keyof OdooProduct]> = [
    ['Display', 'x_test_display'], ['Keyboard', 'x_test_keyboard'],
    ['Touchpad', 'x_test_touchpad'], ['Speakers', 'x_test_speakers'],
    ['Microphone', 'x_test_microphone'], ['Webcam', 'x_test_webcam'],
    ['Wi-Fi', 'x_test_wifi'], ['Bluetooth', 'x_test_bluetooth'],
    ['Ports', 'x_test_ports'], ['Battery Test', 'x_test_battery'],
  ];
  const rows: Array<[string, string]> = [];
  for (const [label, field] of fields) {
    const val = getField(product, field);
    if (isNonemptyValue(val)) rows.push([label, String(val).trim()]);
  }
  return rows;
}

function buildDescriptionFallback(
  product: OdooProduct,
  conditionNotes: string,
  shippingInfo: string,
  returnsPolicy: string,
  highlights?: string[],
): string {
  const brand = esc(String(getField(product, 'x_brand') ?? 'Laptop'));
  const model = esc(String(getField(product, 'x_model_name') ?? ''));
  const series = esc(String(getField(product, 'x_series') ?? ''));
  const headline = [brand, series, model].filter(Boolean).join(' ') || 'Laptop';

  const glanceItems = highlights ?? formatAtAGlance(product);
  const specs = specRows(product);
  const tests = testResultRows(product);
  const batteryHealth = getField(product, 'x_battery_health');
  const batteryCycles = getField(product, 'x_battery_cycles');

  const glanceHtml = glanceItems
    .filter(i => isNonemptyValue(i))
    .map(i => `<li style="margin: 0 0 6px 0;">${esc(i)}</li>`)
    .join('');

  const specHtml = specs.map(([k, v]) =>
    `<tr><td style="padding: 8px 10px; border: 1px solid #d6e0ea; background: #f6f9fc; font-weight: 600; width: 34%;">${esc(k)}</td>` +
    `<td style="padding: 8px 10px; border: 1px solid #d6e0ea;">${esc(v)}</td></tr>`
  ).join('');

  const testHtml = tests.map(([k, v]) =>
    `<tr><td style="padding: 7px 10px; border: 1px solid #d6e0ea; background: #f6f9fc; font-weight: 600; width: 34%;">${esc(k)}</td>` +
    `<td style="padding: 7px 10px; border: 1px solid #d6e0ea;">${esc(v)}</td></tr>`
  ).join('');

  let batteryBlock = '';
  if (isNonemptyValue(batteryHealth) || isNonemptyValue(batteryCycles)) {
    const parts: string[] = [];
    if (isNonemptyValue(batteryHealth)) parts.push(`Health: ${esc(String(batteryHealth))}`);
    if (isNonemptyValue(batteryCycles)) parts.push(`Cycles: ${esc(String(batteryCycles))}`);
    batteryBlock = `<div style="margin: 12px 0 0 0; padding: 12px; border: 1px solid #d6e0ea; background: #f6f9fc;">` +
      `<div style="font-weight: 700; color: #1f4e79; margin-bottom: 6px;">Battery</div>` +
      `<div style="color: #1f2933;">${parts.join(' | ')}</div></div>`;
  }

  let testsBlock = '';
  if (tests.length > 0) {
    testsBlock = `<div style="margin: 14px 0 0 0;">` +
      `<div style="font-weight: 700; color: #1f4e79; margin: 0 0 8px 0;">Test Results</div>` +
      `<table style="width: 100%; border-collapse: collapse; border: 1px solid #d6e0ea;">${testHtml}</table></div>`;
  }

  return `<div style="font-family: Arial, Helvetica, sans-serif; width: 100%; color: #1f2933; line-height: 1.45;">
  <div style="background: linear-gradient(135deg, #1f4e79, #2f7ebd); color: #ffffff; padding: 14px 16px; border-radius: 4px;">
    <div style="font-size: 20px; font-weight: 700; margin-bottom: 3px;">${headline}</div>
    <div style="font-size: 13px; opacity: 0.95;">Pre-owned device listing with verified available details</div>
  </div>
  <div style="margin: 12px 0 0 0; padding: 12px; border: 1px solid #d6e0ea; background: #f6f9fc;">
    <div style="font-weight: 700; color: #1f4e79; margin-bottom: 8px;">At a Glance</div>
    <ul style="margin: 0; padding-left: 18px;">${glanceHtml}</ul>
  </div>
  <div style="margin: 14px 0 0 0;">
    <div style="font-weight: 700; color: #1f4e79; margin: 0 0 8px 0;">Specifications</div>
    <table style="width: 100%; border-collapse: collapse; border: 1px solid #d6e0ea;">${specHtml}</table>
  </div>
  ${testsBlock}
  ${batteryBlock}
  <div style="margin: 12px 0 0 0; padding: 12px; border: 1px solid #d6e0ea; background: #ffffff;">
    <div style="font-weight: 700; color: #1f4e79; margin-bottom: 6px;">Condition</div>
    <div>${esc(conditionNotes)}</div>
  </div>
  <div style="margin: 10px 0 0 0; padding: 12px; border: 1px solid #d6e0ea; background: #ffffff;">
    <div style="font-weight: 700; color: #1f4e79; margin-bottom: 6px;">Shipping</div>
    <div>${esc(shippingInfo)}</div>
  </div>
  <div style="margin: 10px 0 0 0; padding: 12px; border: 1px solid #d6e0ea; background: #ffffff;">
    <div style="font-weight: 700; color: #1f4e79; margin-bottom: 6px;">Returns</div>
    <div>${esc(returnsPolicy)}</div>
  </div>
  <div style="margin: 12px 0 0 0; font-size: 12px; color: #52606d;">Thanks for viewing this listing.</div>
</div>`;
}

// ── Title Scoring ───────────────────────────────────────────────────

function scoreTitleCandidate(title: string, marketContext?: MarketContext): number {
  const titleL = (title ?? '').toLowerCase();
  if (!titleL) return 0;
  let score = 0;
  const length = titleL.trim().length;
  if (length >= 70 && length <= 80) score += 1.0;
  else if (length >= 65 && length <= 80) score += 0.6;
  else score += Math.max(0, 0.4 - Math.abs(length - 75) * 0.01);

  if (marketContext?.keywords) {
    let hits = 0;
    for (const kw of marketContext.keywords.slice(0, 10)) {
      if (kw && titleL.includes(kw.toLowerCase())) hits++;
    }
    score += Math.min(1.0, hits * 0.15);
  }

  const words = titleL.match(/[a-z0-9]+/g) ?? [];
  if (words.length > 0) {
    const counts: Record<string, number> = {};
    for (const w of words) counts[w] = (counts[w] ?? 0) + 1;
    const topRepeat = Math.max(...Object.values(counts));
    if (topRepeat > 2) score -= 0.2 * (topRepeat - 2);
  }

  return score;
}

// ── Types ───────────────────────────────────────────────────────────

interface MarketContext {
  query?: string;
  price_band?: string;
  keywords?: string[];
  example_titles?: string[];
}

// ── Main Class ──────────────────────────────────────────────────────

export class ListingAIGenerator {
  private config: AiConfig;
  private _client: unknown = null;

  constructor(config?: AiConfig) {
    this.config = config ?? loadAiConfig();
  }

  get isConfigured(): boolean {
    return !!(this.config.openai_api_key || process.env.OPENAI_API_KEY);
  }

  private async getClient(): Promise<any> {
    if (!this._client) {
      const apiKey = this.config.openai_api_key || process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error('OpenAI API key not configured');
      const { default: OpenAI } = await import('openai');
      this._client = new OpenAI({ apiKey });
    }
    return this._client;
  }

  private supportsStructuredOutput(): boolean {
    const model = this.config.model ?? 'gpt-4o-mini';
    for (const prefix of STRUCTURED_OUTPUT_MODELS) {
      if (model.startsWith(prefix)) return true;
    }
    return false;
  }

  async generateTitles(
    product: OdooProduct,
    count: number = 5,
    marketContext?: MarketContext,
    categoryContext?: CategoryContext,
  ): Promise<string[]> {
    const productText = formatProductForPrompt(product, categoryContext);
    let systemPrompt = this.config.title_system_prompt ?? DEFAULT_TITLE_PROMPT;
    systemPrompt = applyCategoryPlaceholders(systemPrompt, categoryContext);
    systemPrompt = systemPrompt.replace('{count}', String(count));

    const productType = categoryContext?.categoryName ?? 'laptop';
    let userPrompt = `Generate ${count} eBay listing titles for this ${productType}:\n\n${productText}\n\nEach title must be 70-80 characters.`;

    // Inject category-specific title guidance
    if (categoryContext) {
      userPrompt += renderCategoryContextForTitles(categoryContext);
    }

    if (marketContext) {
      const mktText = renderMarketContext(marketContext);
      if (mktText) userPrompt += `\n\n${mktText}`;
    }

    const model = this.config.model ?? 'gpt-4o-mini';
    const useStructured = (this.config.use_structured_output ?? true) && this.supportsStructuredOutput();
    const client = await this.getClient();

    let content: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const callParams: Record<string, unknown> = {
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.7 + attempt * 0.1,
          max_completion_tokens: 500,
        };
        if (useStructured) {
          callParams.response_format = { type: 'json_schema', json_schema: TITLE_RESPONSE_SCHEMA };
        }
        const response = await client.chat.completions.create(callParams);
        content = response.choices[0]?.message?.content;
        if (content?.trim()) break;
        if (attempt < 2) await sleep(1000);
      } catch (err) {
        console.error(`Title generation error on attempt ${attempt + 1}:`, err);
        if (attempt < 2) await sleep(1000);
        else throw err;
      }
    }

    content = (content ?? '').trim();
    return parseTitleResponse(content, count, marketContext);
  }

  async analyzeCondition(images: OdooImage[]): Promise<{ notes: string; error?: string }> {
    if (!images.length) return { notes: '' };

    const model = this.config.model ?? 'gpt-4o-mini';
    const client = await this.getClient();

    const contentParts: unknown[] = [{
      type: 'text',
      text: 'Examine these photos of a used laptop/device being sold on eBay. ' +
        'Describe the physical condition in 2-4 sentences. Focus on: ' +
        'overall cosmetic state, visible wear/scratches/dents, screen condition, ' +
        'keyboard/palm rest wear, and any notable damage or defects. ' +
        'Be honest and specific. If the item looks clean, say so.',
    }];

    for (const img of images.slice(0, MAX_DESCRIPTION_IMAGES)) {
      if (!img.datas) continue;
      contentParts.push({
        type: 'image_url',
        image_url: {
          url: `data:${img.mimetype ?? 'image/jpeg'};base64,${img.datas}`,
          detail: 'low',
        },
      });
    }

    try {
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: contentParts }],
        max_completion_tokens: 250,
        temperature: 0.3,
      });
      const result = response.choices[0]?.message?.content;
      return { notes: result?.trim() ?? '' };
    } catch (err) {
      console.warn('[ai-generator] Vision condition assessment failed:', err instanceof Error ? err.message : String(err));
      return { notes: '', error: err instanceof Error ? err.message : String(err) };
    }
  }

  async generateDescription(
    product: OdooProduct,
    opts: {
      systemPrompt?: string;
      conditionNotes?: string;
      shippingInfo?: string;
      returnsPolicy?: string;
      images?: OdooImage[];
      categoryContext?: CategoryContext;
    } = {},
  ): Promise<string> {
    const productText = formatProductForPrompt(product, opts.categoryContext);
    const condNotes = opts.conditionNotes ?? this.config.condition_notes ?? DEFAULT_CONDITION_NOTES;
    const shipInfo = opts.shippingInfo ?? this.config.shipping_info ?? DEFAULT_SHIPPING_INFO;
    const retPolicy = opts.returnsPolicy ?? this.config.returns_policy ?? DEFAULT_RETURNS_POLICY;

    let sysPrompt = opts.systemPrompt ?? this.config.description_system_prompt ?? DEFAULT_DESCRIPTION_PROMPT;
    sysPrompt = applyCategoryPlaceholders(sysPrompt, opts.categoryContext);
    sysPrompt = sysPrompt.replace('{condition_notes}', condNotes)
      .replace('{shipping_info}', shipInfo)
      .replace('{returns_policy}', retPolicy);

    const productType = opts.categoryContext?.categoryName ?? 'laptop';
    let userPrompt = `Generate an HTML eBay listing description for this ${productType} using ONLY the data provided below.\n` +
      `Do NOT add any specifications, test results, dimensions, weight, or details not listed here.\n\n` +
      `${productText}\n\nReminder: If no TEST RESULTS section appears above, do NOT include test results in the description.\n` +
      `If no BATTERY STATUS section appears above, do NOT include battery information.`;

    // Inject category-specific description guidance
    if (opts.categoryContext) {
      userPrompt += renderCategoryContextForDescription(opts.categoryContext);
    }

    const hasImages = opts.images?.some(img => img.datas);
    if (hasImages && opts.images) {
      const conditionResult = await this.analyzeCondition(opts.images);
      if (conditionResult.error) {
        console.warn('[ai-generator] generateDescription: Vision condition assessment error:', conditionResult.error);
      }
      if (conditionResult.notes) {
        userPrompt += `\n\nCONDITION ASSESSMENT (from photos):\n${conditionResult.notes}\n\nIncorporate this condition assessment into the Product Overview section.`;
      }
    }

    const model = this.config.model ?? 'gpt-4o-mini';
    const useStructured = (this.config.use_structured_output ?? true) && this.supportsStructuredOutput();
    const client = await this.getClient();

    let rawContent: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const callParams: Record<string, unknown> = {
          model,
          messages: [
            { role: 'system', content: sysPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.5 + attempt * 0.1,
          max_completion_tokens: 3000,
        };
        if (useStructured) {
          callParams.response_format = { type: 'json_schema', json_schema: DESCRIPTION_RESPONSE_SCHEMA };
        }
        const response = await client.chat.completions.create(callParams);
        rawContent = response.choices[0]?.message?.content;
        if (rawContent && rawContent.trim().length > 100) break;
        if (attempt < 2) await sleep(1000);
      } catch (err) {
        console.error(`Description generation error on attempt ${attempt + 1}:`, err);
        if (attempt < 2) await sleep(1000);
        else throw err;
      }
    }

    if (!rawContent) return '';
    return parseDescriptionResponse(rawContent, product, condNotes, shipInfo, retPolicy, useStructured);
  }

  updateConfig(updates: Partial<AiConfig>): void {
    Object.assign(this.config, updates);
    saveAiConfig(this.config);
    if ('openai_api_key' in updates) this._client = null;
  }
}

// ── Response Parsers ────────────────────────────────────────────────

function parseTitleResponse(content: string, count: number, marketContext?: MarketContext): string[] {
  try {
    let cleaned = content;
    if (cleaned.startsWith('```')) {
      const parts = cleaned.split('```');
      cleaned = parts[1] ?? cleaned;
      if (cleaned.startsWith('json')) cleaned = cleaned.slice(4);
    }
    const parsed = JSON.parse(cleaned);
    let rawTitles: unknown[];
    if (parsed && typeof parsed === 'object' && 'titles' in parsed) {
      rawTitles = parsed.titles;
    } else if (Array.isArray(parsed)) {
      rawTitles = parsed;
    } else {
      rawTitles = [content];
    }

    const titles: string[] = [];
    for (const item of rawTitles) {
      if (typeof item === 'object' && item && 'generatedTitle' in (item as Record<string, unknown>)) {
        titles.push((item as Record<string, unknown>).generatedTitle as string);
      } else if (typeof item === 'string') {
        titles.push(item);
      }
    }

    const validated: string[] = [];
    const seen = new Set<string>();
    for (const title of titles) {
      const normalized = normalizeGeneratedTitle(title);
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      validated.push(normalized);
    }

    if (marketContext) {
      validated.sort((a, b) => scoreTitleCandidate(b, marketContext) - scoreTitleCandidate(a, marketContext));
    }
    return validated.slice(0, count);
  } catch (err) {
    console.warn('[ai-generator] parseTitleResponse: Failed to parse JSON from OpenAI response:', err instanceof Error ? err.message : String(err));
    console.warn('[ai-generator] Raw content length:', content?.length ?? 0);
    return [];
  }
}

function parseDescriptionResponse(
  rawContent: string,
  product: OdooProduct,
  condNotes: string,
  shipInfo: string,
  retPolicy: string,
  useStructured: boolean,
): string {
  let content = rawContent.trim();

  const stripCodeBlock = (text: string): string => {
    if (!text.startsWith('```')) return text;
    const lines = text.split('\n');
    if (lines[0]!.startsWith('```')) lines.shift();
    if (lines.length > 0 && lines[lines.length - 1]!.trim() === '```') lines.pop();
    return lines.join('\n');
  };

  try {
    if (useStructured) {
      content = stripCodeBlock(content);
      const parsed = JSON.parse(content);
      const htmlContent = parsed.html ?? '';
      const highlights = parsed.highlights ?? [];
      const cleaned = sanitizeGeneratedDescription(htmlContent);
      const visible = stripHtml(cleaned);
      if (visible.length < 220 || !cleaned.toLowerCase().includes('<table')) {
        return buildDescriptionFallback(product, condNotes, shipInfo, retPolicy, highlights);
      }
      return cleaned;
    }

    content = stripCodeBlock(content);
    const cleaned = sanitizeGeneratedDescription(content);
    const visible = stripHtml(cleaned);
    if (visible.length < 220 || !cleaned.toLowerCase().includes('<table')) {
      return buildDescriptionFallback(product, condNotes, shipInfo, retPolicy);
    }
    return cleaned;
  } catch {
    content = stripCodeBlock(content);
    const cleaned = sanitizeGeneratedDescription(content);
    const visible = stripHtml(cleaned);
    if (visible.length < 220 || !cleaned.toLowerCase().includes('<table')) {
      return buildDescriptionFallback(product, condNotes, shipInfo, retPolicy);
    }
    return cleaned;
  }
}

function renderMarketContext(mc: MarketContext): string {
  if (!mc) return '';
  const lines: string[] = ['MARKET CONTEXT (use for keyword prioritization only):'];
  if (mc.query) lines.push(`- Competitive query: ${mc.query}`);
  if (mc.price_band) lines.push(`- Market price band: ${mc.price_band}`);
  if (mc.keywords?.length) lines.push('- Frequent title keywords: ' + mc.keywords.slice(0, 10).join(', '));
  if (mc.example_titles?.length) {
    lines.push('- Sample competitor titles:');
    for (const t of mc.example_titles.slice(0, 3)) lines.push(`  - ${t}`);
  }
  return lines.join('\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Test Connection ─────────────────────────────────────────────────

export async function testAiConnection(apiKey?: string): Promise<Record<string, unknown>> {
  const config = loadAiConfig();
  if (apiKey) config.openai_api_key = apiKey;
  try {
    const gen = new ListingAIGenerator(config);
    const client = await (gen as any).getClient();
    const response = await client.models.list();
    const models = response.data
      .filter((m: { id: string }) => m.id.toLowerCase().includes('gpt'))
      .map((m: { id: string }) => m.id)
      .slice(0, 10);
    return { status: 'ok', message: 'OpenAI API connection successful', available_models: models };
  } catch (err) {
    return { status: 'error', message: (err as Error).message };
  }
}
