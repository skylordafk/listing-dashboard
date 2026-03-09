import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { EbayConfig } from './types.js';

/** Resolve a config file: try {cwd}/config/ first, then home dir fallback. */
function resolveConfigPath(cwdName: string, homeName: string): string {
  const cwdPath = join(process.cwd(), 'config', cwdName);
  if (existsSync(cwdPath)) return cwdPath;
  return join(homedir(), homeName);
}

/**
 * Load eBay API configuration.
 * Resolution: explicit path > {cwd}/config/ebay-config.json > ~/ebay-config.json
 */
export function loadEbayConfig(configPath?: string): EbayConfig {
  const path = configPath ?? resolveConfigPath('ebay-config.json', 'ebay-config.json');
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(`eBay config not found at ${path}: ${(err as Error).message}`);
  }

  const policies = (raw.business_policies ?? {}) as Record<string, string>;

  return {
    appId: String(raw.app_id ?? ''),
    devId: String(raw.dev_id ?? ''),
    certId: String(raw.cert_id ?? ''),
    oauthToken: String(raw.oauth_token ?? ''),
    refreshToken: raw.refresh_token ? String(raw.refresh_token) : undefined,
    redirectUri: raw.redirect_uri ? String(raw.redirect_uri) : undefined,
    apiUrl: String(raw.api_url ?? 'https://api.ebay.com/ws/api.dll'),
    apiVersion: String(raw.api_version ?? '1355'),
    siteId: String(raw.site_id ?? '0'),
    postalCode: String(raw.postal_code ?? ''),
    location: String(raw.location ?? 'United States'),
    businessPolicies: {
      paymentPolicyId: String(policies.payment_policy_id ?? ''),
      returnPolicyId: String(policies.return_policy_id ?? ''),
      shippingPolicyId: String(policies.shipping_policy_id ?? ''),
    },
    defaultConditionDescription: String(raw.default_condition_description ?? ''),
  };
}
