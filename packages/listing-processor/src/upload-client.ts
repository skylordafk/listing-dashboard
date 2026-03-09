// HTTP client for the Upload API on port 5051.
// Port of _call_upload_api() from app.py.

import { createHash } from 'node:crypto';
import { UPLOAD_API_URL, loadUploadApiKey } from './config.js';

export interface UploadApiResult {
  ok: boolean;
  error_type?: string;
  message?: string;
  status_code?: number;
  data?: Record<string, unknown>;
}

interface CallOptions {
  method?: string;
  payload?: unknown;
  timeout?: number;
  retries?: number;
  retryOn5xx?: boolean;
  idempotencyKey?: string;
}

export async function callUploadApi(
  path: string,
  opts: CallOptions = {},
): Promise<UploadApiResult> {
  const apiKey = loadUploadApiKey();
  const method = (opts.method ?? 'POST').toUpperCase();
  const maxAttempts = 1 + Math.max(0, opts.retries ?? 0);
  const timeoutMs = (opts.timeout ?? 60) * 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const headers: Record<string, string> = { 'X-API-Key': apiKey };
      if (opts.idempotencyKey) headers['X-Idempotency-Key'] = opts.idempotencyKey;

      const fetchOpts: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      };

      if (opts.payload != null && ['POST', 'PUT', 'PATCH'].includes(method)) {
        headers['Content-Type'] = 'application/json';
        fetchOpts.body = JSON.stringify(opts.payload);
      }

      const url = `${UPLOAD_API_URL}${path}`;
      const resp = await fetch(url, fetchOpts);

      // Retry on 5xx if configured
      if (opts.retryOn5xx && resp.status >= 500 && attempt < maxAttempts) {
        console.warn(`Upload API HTTP ${resp.status} (${path}), retrying ${attempt}/${maxAttempts}`);
        await sleep(2 ** (attempt - 1) * 1000);
        continue;
      }

      let data: Record<string, unknown>;
      try {
        data = await resp.json() as Record<string, unknown>;
      } catch {
        return {
          ok: false,
          error_type: 'non_json',
          message: `Upload API returned non-JSON response (HTTP ${resp.status})`,
        };
      }

      if (resp.status >= 400) {
        return {
          ok: false,
          error_type: 'http_error',
          status_code: resp.status,
          data,
          message: String(data.error ?? `HTTP ${resp.status}`),
        };
      }

      return { ok: true, status_code: resp.status, data };
    } catch (err) {
      const error = err as Error;

      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        if (attempt < maxAttempts) {
          console.warn(`Upload API timeout (${path}), retrying ${attempt}/${maxAttempts}`);
          await sleep(2 ** (attempt - 1) * 1000);
          continue;
        }
        return { ok: false, error_type: 'timeout', message: 'Request timed out' };
      }

      if (error.message?.includes('ECONNREFUSED') || error.message?.includes('fetch failed')) {
        if (attempt < maxAttempts) {
          console.warn(`Upload API connection error (${path}), retrying ${attempt}/${maxAttempts}`);
          await sleep(2 ** (attempt - 1) * 1000);
          continue;
        }
        return {
          ok: false,
          error_type: 'connection',
          message: 'Cannot connect to upload API (is it running on port 5051?)',
        };
      }

      return { ok: false, error_type: 'exception', message: error.message };
    }
  }

  return { ok: false, error_type: 'unknown', message: 'Upload API request failed' };
}

// ── Helpers ─────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function buildIdempotencyKey(
  operation: string,
  listingId: number,
  fingerprintText: string,
): string {
  const digest = createHash('sha256').update(fingerprintText ?? '').digest('hex').slice(0, 24);
  return `${operation}:${listingId}:${digest}`;
}

export interface ParsedFee {
  name: string;
  amount: number;
}

export function extractNonzeroFees(fees: unknown[]): ParsedFee[] {
  const parsed: ParsedFee[] = [];
  for (const fee of fees ?? []) {
    if (!fee || typeof fee !== 'object') continue;
    const f = fee as Record<string, unknown>;
    const amount = f.amount != null ? Number(f.amount) : NaN;
    if (isNaN(amount) || amount <= 0) continue;
    parsed.push({ name: String(f.name ?? 'Fee'), amount });
  }
  return parsed;
}

export function formatUploadApiError(result: UploadApiResult, actionLabel: string): string {
  const errorType = result.error_type;
  const message = result.message ?? 'Unknown error';
  if (errorType === 'timeout') return `${actionLabel} timed out. Check upload API logs.`;
  if (errorType === 'connection') return message;
  if (errorType === 'non_json') return message;
  return `${actionLabel} error: ${message}`;
}
