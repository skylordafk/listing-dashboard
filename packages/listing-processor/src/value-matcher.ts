// Smart value matching — normalize Odoo values to eBay allowed values.
// Used by both the normalizer (server-side) and preview page (client-side via compact port).

// ── Name Alias Groups ───────────────────────────────────────────────
// Each group contains names that refer to the same concept.
// normalizeSpecificNameForCategory() picks the one that exists in eBay's aspect list.

export const NAME_ALIAS_GROUPS: string[][] = [
  ['Storage Capacity', 'Hard Drive Capacity', 'HDD Capacity'],
  ['RAM Size', 'RAM', 'Memory'],
  ['Processor', 'CPU', 'Processor Model', 'Processor Type'],
  ['GPU', 'Graphics', 'Graphics Card', 'Video Card'],
  ['Screen Size', 'Screen', 'Display Size'],
  ['Maximum Resolution', 'Resolution', 'Display Resolution'],
  ['Operating System', 'OS', 'Operating System Edition'],
  ['Storage Type', 'Hard Drive Type', 'Drive Type'],
];

// Precompute lowercase lookup: lowercased name → group
const _aliasLookup: Record<string, string[]> = {};
for (const group of NAME_ALIAS_GROUPS) {
  for (const name of group) {
    _aliasLookup[name.toLowerCase()] = group;
  }
}

/**
 * Given a spec name and the set of eBay aspect names for this category,
 * find the matching eBay aspect name (resolving aliases).
 * Returns the eBay name if found, or the original name if no alias match.
 */
export function resolveSpecNameForCategory(
  specName: string,
  ebayAspectNames: Set<string> | string[],
): string {
  const names = ebayAspectNames instanceof Set ? ebayAspectNames : new Set(ebayAspectNames);

  // Direct match (case-insensitive)
  for (const eName of names) {
    if (eName.toLowerCase() === specName.toLowerCase()) return eName;
  }

  // Alias group lookup
  const group = _aliasLookup[specName.toLowerCase()];
  if (group) {
    for (const alias of group) {
      for (const eName of names) {
        if (eName.toLowerCase() === alias.toLowerCase()) return eName;
      }
    }
  }

  return specName;
}

/**
 * Reverse lookup: given an eBay aspect name, find matching spec name(s)
 * in existing specs (resolving aliases).
 */
export function findSpecValueByAspectName(
  aspectName: string,
  specMap: Record<string, string[]>,
): string[] | undefined {
  const key = aspectName.toLowerCase();

  // Direct match
  if (specMap[key]) return specMap[key];

  // Alias group lookup
  const group = _aliasLookup[key];
  if (group) {
    for (const alias of group) {
      const aliasKey = alias.toLowerCase();
      if (specMap[aliasKey]) return specMap[aliasKey];
    }
  }

  return undefined;
}

// ── Value Matching ──────────────────────────────────────────────────

/**
 * Normalize a string for comparison: lowercase, strip (R), (TM), trim extra spaces.
 */
function normalize(s: string): string {
  return s
    .replace(/\(R\)/gi, '')
    .replace(/\(TM\)/gi, '')
    .replace(/®/g, '')
    .replace(/™/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Strip parenthetical suffixes: "SSD (Solid State Drive)" → "SSD"
 */
function stripParens(s: string): string {
  return s.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
}

/**
 * Extract tokens from a string (split on spaces, punctuation).
 */
function tokenize(s: string): string[] {
  return normalize(s)
    .split(/[\s,;|/]+/)
    .map(t => t.replace(/[^a-z0-9.-]/g, ''))
    .filter(t => t.length > 0);
}

/**
 * Calculate Jaccard-like token overlap score between two strings.
 * Returns a value between 0 and 1.
 */
function tokenOverlap(a: string, b: string): number {
  const tokA = new Set(tokenize(a));
  const tokB = new Set(tokenize(b));
  if (tokA.size === 0 || tokB.size === 0) return 0;

  let intersection = 0;
  for (const t of tokA) {
    if (tokB.has(t)) intersection++;
  }

  const union = new Set([...tokA, ...tokB]).size;
  return intersection / union;
}

/**
 * Extract numeric value and unit from strings like "16 GB", "256GB", "14.1 in", "1 TB".
 */
function extractNumericUnit(s: string): { num: number; unit: string } | null {
  const m = s.match(/(\d+(?:\.\d+)?)\s*(gb|tb|mb|ghz|mhz|in|\")/i);
  if (!m) return null;
  return { num: parseFloat(m[1]!), unit: m[2]!.toLowerCase().replace('"', 'in') };
}

/**
 * Clean a processor string: strip Intel(R), Core(TM), @ speed suffix.
 */
export function cleanProcessorString(raw: string): string {
  let p = raw;
  // Remove (R), (TM), ®, ™
  p = p.replace(/\(R\)/gi, '').replace(/\(TM\)/gi, '');
  p = p.replace(/®/g, '').replace(/™/g, '');
  // Remove "@ X.XXGHz" suffix
  p = p.replace(/@\s*[\d.]+\s*[GM]Hz/i, '');
  // Remove trailing "Processor", "CPU"
  p = p.replace(/\s+(Processor|CPU)$/i, '');
  // Normalize whitespace
  p = p.replace(/\s+/g, ' ').trim();
  return p;
}

/**
 * Extract the specific model identifier from a processor string.
 * E.g., "Intel(R) Core(TM) i7-1165G7 @ 2.80GHz" → "i7-1165G7"
 */
function extractProcessorModel(raw: string): string | null {
  const m = raw.match(/\b(i[3579]-\w+|[AE]\d+-\w+|Ryzen\s+\d+\s+\w+)/i);
  return m ? m[1]! : null;
}

/**
 * Detect Intel Core processor generation from model number.
 * i7-6500U → { family: "i7", gen: 6 }
 * i5-1135G7 → { family: "i5", gen: 11 }
 * i7-13700H → { family: "i7", gen: 13 }
 */
function detectIntelGen(raw: string): { family: string; gen: number } | null {
  // Match iX-NNNNN patterns
  const m = raw.match(/\b(i[3579])-(\d{4,5})/i);
  if (!m) return null;
  const family = m[1]!.toLowerCase();
  const modelNum = m[2]!;
  let gen: number;
  if (modelNum.length === 4) {
    // 4-digit: first digit is gen (e.g., 6500 = 6th, 8250 = 8th)
    gen = parseInt(modelNum[0]!, 10);
  } else {
    // 5-digit: first two digits are gen (e.g., 10510 = 10th, 13700 = 13th)
    gen = parseInt(modelNum.slice(0, 2), 10);
  }
  if (gen < 1 || gen > 30) return null;
  return { family, gen };
}

export interface MatchResult {
  value: string;
  confidence: number;
  strategy: string;
}

/**
 * Smart-match a raw value against a list of eBay allowed values.
 * Returns the best match with confidence score, or null if no reasonable match.
 *
 * Strategies (in priority order):
 * 1. Exact case-insensitive match (confidence: 1.0)
 * 2. Normalized match — strip (R), (TM), extra spaces (confidence: 0.95)
 * 3. Stripped parens match — ignore parenthetical descriptions (confidence: 0.9)
 * 4. Numeric+unit match — for RAM/Storage/Screen (confidence: 0.85)
 * 5. Processor model match — match on CPU model number (confidence: 0.85)
 * 6. Token overlap — find best overlapping candidate (confidence: overlap * 0.85)
 * 7. Contains match — one string contains the other (confidence: 0.7)
 */
export function matchValue(
  rawValue: string,
  allowedValues: string[],
  aspectName?: string,
): MatchResult | null {
  if (!rawValue || !allowedValues || allowedValues.length === 0) return null;

  const raw = rawValue.trim();
  if (!raw) return null;
  const rawLow = raw.toLowerCase();

  // Build lookup maps
  const byLower: Record<string, string> = {};
  const byNorm: Record<string, string> = {};
  const byStripped: Record<string, string> = {};
  for (const v of allowedValues) {
    const trimmed = v.trim();
    if (!trimmed) continue;
    byLower[trimmed.toLowerCase()] = trimmed;
    byNorm[normalize(trimmed)] = trimmed;
    byStripped[stripParens(trimmed).toLowerCase()] = trimmed;
  }

  // Strategy 1: Exact case-insensitive
  if (byLower[rawLow]) {
    return { value: byLower[rawLow]!, confidence: 1.0, strategy: 'exact' };
  }

  // Strategy 2: Normalized (strip (R), (TM), etc.)
  const rawNorm = normalize(raw);
  if (byNorm[rawNorm]) {
    return { value: byNorm[rawNorm]!, confidence: 0.95, strategy: 'normalized' };
  }

  // Strategy 3: Stripped parens
  const rawStripped = stripParens(raw).toLowerCase();
  if (byStripped[rawStripped]) {
    return { value: byStripped[rawStripped]!, confidence: 0.9, strategy: 'stripped-parens' };
  }
  // Also try: raw matches the stripped form of an allowed value
  if (byStripped[rawLow]) {
    return { value: byStripped[rawLow]!, confidence: 0.9, strategy: 'stripped-parens' };
  }
  // Reverse: allowed value stripped matches our raw
  for (const v of allowedValues) {
    if (stripParens(v).toLowerCase() === rawLow) {
      return { value: v, confidence: 0.9, strategy: 'stripped-parens-rev' };
    }
  }

  // Strategy 4: Numeric+unit extraction (for RAM, Storage, Screen Size)
  const rawNumeric = extractNumericUnit(raw);
  if (rawNumeric) {
    for (const v of allowedValues) {
      const candNumeric = extractNumericUnit(v);
      if (candNumeric && candNumeric.num === rawNumeric.num && candNumeric.unit === rawNumeric.unit) {
        return { value: v, confidence: 0.85, strategy: 'numeric-unit' };
      }
    }
  }

  // Strategy 5: Processor matching (model → cleaned → generation)
  const isProcessor = aspectName && /processor/i.test(aspectName);
  if (isProcessor || /\b(i[3579]-|Ryzen|Core|Celeron|Pentium|Atom)/i.test(raw)) {
    // 5a: Exact model match (e.g., "i7-1165G7" found in allowed values)
    const rawModel = extractProcessorModel(raw);
    if (rawModel) {
      const rawModelLow = rawModel.toLowerCase();
      for (const v of allowedValues) {
        if (v.toLowerCase().includes(rawModelLow)) {
          return { value: v, confidence: 0.9, strategy: 'processor-model' };
        }
      }
    }
    // 5b: Try cleaned processor string
    const cleaned = cleanProcessorString(raw);
    const cleanedLow = cleaned.toLowerCase();
    if (byLower[cleanedLow]) {
      return { value: byLower[cleanedLow]!, confidence: 0.85, strategy: 'processor-cleaned' };
    }
    for (const v of allowedValues) {
      if (normalize(v) === normalize(cleaned)) {
        return { value: v, confidence: 0.85, strategy: 'processor-cleaned-norm' };
      }
    }
    // 5c: Generation match (e.g., i7-6500U → "Intel Core i7 6th Gen.")
    const genInfo = detectIntelGen(raw);
    if (genInfo) {
      const genSuffix = genInfo.gen + (genInfo.gen === 1 ? 'st' : genInfo.gen === 2 ? 'nd' : genInfo.gen === 3 ? 'rd' : 'th');
      const pattern = new RegExp(
        `Intel\\s+Core\\s+${genInfo.family}\\s+${genSuffix}\\s+Gen`,
        'i',
      );
      for (const v of allowedValues) {
        if (pattern.test(v)) {
          return { value: v, confidence: 0.8, strategy: 'processor-generation' };
        }
      }
    }
    // 5d: AMD Ryzen generation match
    const ryzenMatch = raw.match(/Ryzen\s+(\d+)\s+(\d)(\d{3})/i);
    if (ryzenMatch) {
      const tier = ryzenMatch[1]; // 3,5,7,9
      const series = ryzenMatch[2] + '000'; // e.g., 5600 → 5000
      const seriesPattern = new RegExp(`Ryzen\\s+${tier}\\s+${series}\\s+Series`, 'i');
      for (const v of allowedValues) {
        if (seriesPattern.test(v)) {
          return { value: v, confidence: 0.8, strategy: 'processor-generation' };
        }
      }
    }
  }

  // Strategy 6: Bracket/parenthetical extraction (for GPU, features with [model] notation)
  const bracketMatch = raw.match(/\[([^\]]{3,})\]/);
  if (bracketMatch) {
    const inner = bracketMatch[1]!.toLowerCase();
    for (const v of allowedValues) {
      if (v.toLowerCase().includes(inner) || inner.includes(v.toLowerCase())) {
        return { value: v, confidence: 0.8, strategy: 'bracket-extract' };
      }
    }
  }

  // Strategy 7: Contains match (raw or normalized, meaningful length)
  // Check both raw and normalized versions for contains
  for (const v of allowedValues) {
    const vLow = v.toLowerCase();
    const vNorm = normalize(v);
    if (rawLow.includes(vLow) || vLow.includes(rawLow) ||
        rawNorm.includes(vNorm) || vNorm.includes(rawNorm)) {
      const shorter = Math.min(rawNorm.length, vNorm.length);
      const longer = Math.max(rawNorm.length, vNorm.length);
      // Require meaningful overlap: at least 3 chars and reasonable ratio
      // Relax ratio for shorter candidate values (brand names like "HP", "ASUS")
      const minRatio = shorter <= 6 ? 0.15 : 0.3;
      if (shorter >= 3 && shorter / longer >= minRatio) {
        return { value: v, confidence: 0.75, strategy: 'contains' };
      }
    }
  }

  // Strategy 8: Stripped suffix match (remove "Inc.", "Corp.", etc.)
  const suffixStripped = rawLow.replace(/\s+(inc\.?|corp\.?|ltd\.?|llc|co\.?)\s*$/i, '').trim();
  if (suffixStripped !== rawLow) {
    for (const v of allowedValues) {
      if (v.toLowerCase() === suffixStripped) {
        return { value: v, confidence: 0.9, strategy: 'suffix-stripped' };
      }
    }
  }

  // Strategy 9: Token overlap (high threshold only)
  let bestOverlap: MatchResult | null = null;
  for (const v of allowedValues) {
    const score = tokenOverlap(raw, v);
    if (score >= 0.6 && (!bestOverlap || score * 0.85 > bestOverlap.confidence)) {
      bestOverlap = { value: v, confidence: Math.round(score * 85) / 100, strategy: 'token-overlap' };
    }
  }
  if (bestOverlap && bestOverlap.confidence >= 0.7) return bestOverlap;

  return null;
}

/**
 * Convenience: match a value and return just the matched string (or the original if no match).
 */
export function matchValueOrKeep(
  rawValue: string,
  allowedValues: string[],
  aspectName?: string,
): string {
  const result = matchValue(rawValue, allowedValues, aspectName);
  return result ? result.value : rawValue;
}
