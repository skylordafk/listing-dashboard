// Taxonomy REST API client — category suggestions + item aspects.
// Uses client credentials grant (app_id + cert_id), no user auth needed.

import { EbayApiError, EbayAuthError } from './errors.js';
import type { EbayConfig } from './types.js';

// ── Types ───────────────────────────────────────────────────────────

export interface CategorySuggestion {
  categoryId: string;
  categoryName: string;
  breadcrumb: string[];  // root → leaf
  level: number;
}

export interface CategorySuggestionsResult {
  categoryTreeId: string;
  suggestions: CategorySuggestion[];
}

export interface TaxonomyAspect {
  name: string;
  required: boolean;
  usage: string;          // RECOMMENDED | OPTIONAL
  dataType: string;       // STRING | NUMBER | DATE
  mode: string;           // FREE_TEXT | SELECTION_ONLY
  multiValue: boolean;
  values: string[];
}

export interface ItemAspectsResult {
  categoryId: string;
  categoryTreeId: string;
  aspects: TaxonomyAspect[];
}

// ── Token Cache ─────────────────────────────────────────────────────

let _cachedToken: { token: string; expiresAt: number } | null = null;

// ── Client ──────────────────────────────────────────────────────────

const TAXONOMY_BASE = 'https://api.ebay.com/commerce/taxonomy/v1';
const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const DEFAULT_TREE_ID = '0'; // US eBay
const FETCH_TIMEOUT_MS = 30_000;

export class EbayTaxonomyClient {
  private config: EbayConfig;

  constructor(config: EbayConfig) {
    this.config = config;
  }

  // ── OAuth Client Credentials ────────────────────────────────────

  private async getToken(): Promise<string> {
    if (_cachedToken && Date.now() < _cachedToken.expiresAt - 60_000) {
      return _cachedToken.token;
    }

    const { appId, certId } = this.config;
    if (!appId || !certId) throw new EbayAuthError('appId and certId required for Taxonomy API');

    const b64 = Buffer.from(`${appId}:${certId}`).toString('base64');
    let res: Response;
    try {
      res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${b64}`,
        },
        body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new EbayApiError(`eBay OAuth token request timed out after 30s`);
      }
      throw err;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new EbayAuthError(`Client credentials grant failed (${res.status}): ${text.slice(0, 300)}`);
    }

    const data = await res.json() as { access_token: string; expires_in: number };
    _cachedToken = {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return _cachedToken.token;
  }

  private async get(url: string): Promise<unknown> {
    const token = await this.getToken();
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new EbayApiError(`Taxonomy API request timed out after 30s: ${url}`);
      }
      throw err;
    }
    if (res.status === 401 || res.status === 403) {
      _cachedToken = null;
      throw new EbayAuthError(`Taxonomy API auth failed (${res.status})`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new EbayApiError(`Taxonomy API error (${res.status}): ${text.slice(0, 500)}`);
    }
    return res.json();
  }

  // ── Category Suggestions ────────────────────────────────────────

  async getCategorySuggestions(
    query: string,
    treeId = DEFAULT_TREE_ID,
  ): Promise<CategorySuggestionsResult> {
    const encoded = encodeURIComponent(query);
    const url = `${TAXONOMY_BASE}/category_tree/${treeId}/get_category_suggestions?q=${encoded}`;
    const data = await this.get(url) as Record<string, unknown>;

    const suggestions: CategorySuggestion[] = [];
    const rawSuggestions = (data.categorySuggestions ?? []) as Array<Record<string, unknown>>;

    for (const s of rawSuggestions) {
      const cat = s.category as Record<string, string>;
      const ancestors = (s.categoryTreeNodeAncestors ?? []) as Array<Record<string, string>>;

      // Build breadcrumb: ancestors are leaf→root, reverse to root→leaf, then append leaf
      const breadcrumb = ancestors
        .sort((a, b) => Number(a.categoryTreeNodeLevel) - Number(b.categoryTreeNodeLevel))
        .map(a => a.categoryName)
        .concat(cat.categoryName);

      suggestions.push({
        categoryId: cat.categoryId,
        categoryName: cat.categoryName,
        breadcrumb,
        level: Number(s.categoryTreeNodeLevel ?? 0),
      });
    }

    return {
      categoryTreeId: String(data.categoryTreeId ?? treeId),
      suggestions,
    };
  }

  // ── Item Aspects for Category ───────────────────────────────────

  async getItemAspects(
    categoryId: string,
    treeId = DEFAULT_TREE_ID,
  ): Promise<ItemAspectsResult> {
    const url = `${TAXONOMY_BASE}/category_tree/${treeId}/get_item_aspects_for_category?category_id=${categoryId}`;
    const data = await this.get(url) as Record<string, unknown>;

    const aspects: TaxonomyAspect[] = [];
    const rawAspects = (data.aspects ?? []) as Array<Record<string, unknown>>;

    for (const a of rawAspects) {
      const name = String(a.localizedAspectName ?? '');
      if (!name) continue;

      const constraint = (a.aspectConstraint ?? {}) as Record<string, unknown>;
      const values = ((a.aspectValues ?? []) as Array<Record<string, string>>)
        .map(v => v.localizedValue)
        .filter(Boolean);

      aspects.push({
        name,
        required: constraint.aspectRequired === true,
        usage: String(constraint.aspectUsage ?? 'RECOMMENDED'),
        dataType: String(constraint.aspectDataType ?? 'STRING'),
        mode: String(constraint.aspectMode ?? 'FREE_TEXT'),
        multiValue: String(constraint.itemToAspectCardinality ?? '') === 'MULTI',
        values,
      });
    }

    // Sort: required first, then alphabetical
    aspects.sort((a, b) => {
      if (a.required !== b.required) return a.required ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

    return { categoryId, categoryTreeId: String(data.categoryTreeId ?? treeId), aspects };
  }
}
