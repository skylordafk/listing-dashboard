import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true, // Strip eBay namespace prefixes
  isArray: (tagName) => {
    // These elements should always be arrays even when there's only one
    const arrayTags = new Set([
      'Errors', 'Fee', 'NameRecommendation', 'ValueRecommendation',
      'NameValueList', 'PictureURL', 'ShippingServiceOptions',
      'Transaction', 'Item',
    ]);
    return arrayTags.has(tagName);
  },
});

/** Parse eBay XML response into a JS object. */
export function parseXml(xml: string | Buffer): Record<string, unknown> {
  return parser.parse(xml) as Record<string, unknown>;
}

/** Escape text for safe XML content insertion. */
export function xmlEscape(text: unknown): string {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Safely dig into a parsed XML tree.
 * Returns the value at the given dot-separated path, or undefined.
 */
export function xmlGet(obj: unknown, path: string): unknown {
  let current = obj;
  for (const key of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Escape a string for safe use inside a CDATA section.
 * The sequence `]]>` ends a CDATA section prematurely; split it across two
 * adjacent CDATA sections so the content is preserved verbatim.
 */
export function safeCdata(html: string): string {
  return html.replaceAll(']]>', ']]]]><![CDATA[>');
}

/**
 * Find all elements with a given key anywhere in the tree.
 * Returns flat array of matching values.
 */
export function xmlFindAll(obj: unknown, key: string): unknown[] {
  const results: unknown[] = [];
  const stack = [obj];
  while (stack.length) {
    const node = stack.pop();
    if (node == null || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
    } else {
      const rec = node as Record<string, unknown>;
      if (key in rec) {
        const val = rec[key];
        if (Array.isArray(val)) results.push(...val);
        else results.push(val);
      }
      for (const val of Object.values(rec)) {
        if (val != null && typeof val === 'object') stack.push(val);
      }
    }
  }
  return results;
}
