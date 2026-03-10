// Category specifics cache.

import { callUploadApi } from '../upload-client.js';
import { EBAY_CATEGORY_LAPTOP } from '../field-mapper.js';

export const _categorySpecCache: Record<string, { fetchedAt: number; value: Record<string, string[]> }> = {};
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export async function getCategorySpecificOptions(categoryId: string = EBAY_CATEGORY_LAPTOP): Promise<Record<string, string[]>> {
  const cached = _categorySpecCache[categoryId];
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) return cached.value;

  // Try Taxonomy REST API first (richer data), fall back to Trading API
  let result = await callUploadApi(`/api/taxonomy/aspects/${categoryId}`, { method: 'GET', timeout: 25 });
  if (!result.ok) {
    result = await callUploadApi(`/api/category-specifics/${categoryId}`, { method: 'GET', timeout: 25 });
  }
  if (!result.ok) return cached?.value ?? {};

  const data = result.data ?? {};
  const options: Record<string, string[]> = {};
  // Taxonomy API uses 'name', Trading API also uses 'name' — both have 'values' array
  for (const aspect of (data.aspects as Array<{ name: string; values: string[] }>) ?? []) {
    const name = aspect.name?.trim();
    if (!name) continue;
    options[name] = (aspect.values ?? []).map(v => String(v).trim()).filter(Boolean);
  }

  _categorySpecCache[categoryId] = { fetchedAt: Date.now(), value: options };
  return options;
}
