// Config loading for AI generator and eBay settings.
// Resolution order: explicit path > env var > {cwd}/config/ > ~/

import { readFileSync, writeFileSync, mkdtempSync, renameSync, unlinkSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';

// ── Path Resolution ─────────────────────────────────────────────────

/** Resolve a config file path: try {cwd}/config/ first, then home dir fallback. */
function resolveConfigPath(cwdName: string, homeName: string): string {
  const cwdPath = join(process.cwd(), 'config', cwdName);
  if (existsSync(cwdPath)) return cwdPath;
  return join(homedir(), homeName);
}

// ── AI Config ───────────────────────────────────────────────────────

export const DEFAULT_TITLE_PROMPT = `You are an eBay listing title optimizer for {product_type}.

Generate {count} different SEO-optimized listing titles for this product.

Rules:
- Each title MUST be 70-80 characters (count precisely, spaces included)
- Front-load the most searched keywords (Brand, Model, Processor)
- Front-load eBay required item specifics: {required_aspects}
- Include recommended aspects if space allows: {recommended_aspects}
- Include key specs: Brand, Model/Series, Processor, RAM, Storage, Screen Size
- Use common eBay search terms and abbreviations (e.g., "14in" not "14-inch")
- No special characters except spaces and standard punctuation
- No ALL CAPS except for acronyms (RAM, SSD, FHD, DDR4)
- Vary the titles: spec-packed, benefit-led, and condition-forward angles

Quality check each title before returning.`;

export const DEFAULT_DESCRIPTION_PROMPT = `You are an eBay listing description writer for {product_type}.

Generate an HTML-formatted eBay listing description for this product.

CRITICAL ACCURACY RULES:
- ONLY include information explicitly provided in the product data below.
- NEVER fabricate, infer, or assume ANY specifications, test results, dimensions,
  weight, features, or details not present in the data.
- If test results are NOT provided, do NOT include a test results section.
  Do NOT claim the product has been tested or that tests passed.
- If battery health data is NOT provided, do NOT include a battery section.
- Do NOT add dimensions, weight, screen technology, or other specs from your
  general knowledge — only use what is in the data.
- If a field says "N/A" or is missing, omit it entirely rather than guessing.
- Prioritize eBay required aspects in the specifications table: {required_aspects}
- Include recommended aspects when data is available: {recommended_aspects}

HTML/CSS CONSTRAINTS (eBay-specific):
- Inline CSS only. eBay strips <style> tags and JavaScript.
- DO NOT use max-width on containers.
- Use width: 100% for containers and tables.
- Use <table> for layout and specs.
- Safe fonts: Arial, Helvetica, sans-serif.

VISUAL STYLE (modern, flexible):
- Create a clean card layout with subtle section backgrounds and generous spacing.
- Use this palette:
  - Primary: #1f4e79
  - Accent: #2f7ebd
  - Surface alt: #f6f9fc
  - Border: #d6e0ea
  - Text: #1f2933
- Use short section headers and avoid huge text blocks.
- Prefer concise bullets + tables over dense paragraphs.

REQUIRED STRUCTURE:
1. Header band with product identity
2. At-a-Glance block (3-6 bullets from provided data only)
3. Specifications table (ONLY provided specs — prioritize required aspects first, then recommended)
4. Optional Test Results table (ONLY if test fields provided)
5. Optional Battery block (ONLY if battery fields provided)
6. Condition / Shipping / Returns as separate small blocks
7. Short footer message

If test results and battery data are provided, use them to build buyer confidence.
If they are NOT provided, simply omit those sections entirely.`;

export const DEFAULT_CONDITION_NOTES = `Item may show signs of normal use including minor scratches or wear.
Battery capacity may be reduced from original.
No operating system included unless specified.`;

export const DEFAULT_SHIPPING_INFO = `Ships within 1-2 business days via USPS or UPS.
Carefully packaged to ensure safe delivery.
Tracking provided for all shipments.`;

export const DEFAULT_RETURNS_POLICY = `30-day returns accepted.
Item must be returned in original condition.
Buyer pays return shipping unless item not as described.`;

export interface AiConfig {
  openai_api_key: string;
  model: string;
  title_system_prompt: string;
  description_system_prompt: string;
  condition_notes: string;
  shipping_info: string;
  returns_policy: string;
  use_structured_output: boolean;
  [key: string]: unknown;
}

export function loadAiConfig(configPath?: string): AiConfig {
  const path = configPath ?? resolveConfigPath('listing-ai-config.json', '.listing-ai-config.json');
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf-8');
      return JSON.parse(raw) as AiConfig;
    } catch (err) {
      console.warn(`Failed to load AI config from ${path}:`, err);
    }
  }
  return {
    openai_api_key: process.env.OPENAI_API_KEY ?? '',
    model: 'gpt-4o-mini',
    title_system_prompt: DEFAULT_TITLE_PROMPT,
    description_system_prompt: DEFAULT_DESCRIPTION_PROMPT,
    condition_notes: DEFAULT_CONDITION_NOTES,
    shipping_info: DEFAULT_SHIPPING_INFO,
    returns_policy: DEFAULT_RETURNS_POLICY,
    use_structured_output: true,
  };
}

export function saveAiConfig(config: AiConfig, configPath?: string): void {
  const path = configPath ?? resolveConfigPath('listing-ai-config.json', '.listing-ai-config.json');
  atomicWriteJson(path, config);
}

// ── eBay Config ─────────────────────────────────────────────────────

export interface EbayAppConfig {
  postal_code?: string;
  location?: string;
  default_condition_description?: string;
  business_policies?: {
    payment_policy_id?: string;
    return_policy_id?: string;
    shipping_policy_id?: string;
  };
  [key: string]: unknown;
}

export function loadEbayAppConfig(configPath?: string): EbayAppConfig {
  const path = configPath ?? resolveConfigPath('ebay-config.json', 'ebay-config.json');
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf-8');
      return JSON.parse(raw) as EbayAppConfig;
    } catch {
      return {};
    }
  }
  return {};
}

export function saveEbayAppConfig(config: EbayAppConfig, configPath?: string): void {
  const path = configPath ?? resolveConfigPath('ebay-config.json', 'ebay-config.json');
  atomicWriteJson(path, config);
}

// ── Helpers ─────────────────────────────────────────────────────────

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  const tmpPath = filePath + '.tmp.' + Date.now();
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

// ── Upload API Key ──────────────────────────────────────────────────

export function loadUploadApiKey(): string {
  const envKey = process.env.EBAY_UPLOAD_API_KEY;
  if (envKey) return envKey;

  // Check config directory
  const configKeyFile = join(process.cwd(), 'config', 'upload-api.key');
  if (existsSync(configKeyFile)) {
    const k = readFileSync(configKeyFile, 'utf-8').trim();
    if (k) return k;
  }

  // Legacy fallback
  const legacyKeyFile = join(homedir(), 'ebay-upload-api', '.api-key');
  if (existsSync(legacyKeyFile)) {
    return readFileSync(legacyKeyFile, 'utf-8').trim();
  }
  return '';
}

export const UPLOAD_API_URL = process.env.EBAY_UPLOAD_API_URL ?? 'http://localhost:5051';
