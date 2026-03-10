import type Database from 'better-sqlite3';
import { getIdempotencyKey } from '../db.js';

export function normalizeIdempotencyKey(req: { headers: Record<string, unknown> }): string | null {
  const key = String(req.headers['x-idempotency-key'] ?? '').trim();
  return key || null;
}

export function checkIdempotencyReplay(
  db: Database.Database,
  operation: string,
  key: string,
  fingerprint: string,
): { body: unknown; status: number } | null {
  const row = getIdempotencyKey(db, operation, key);
  if (!row) return null;

  if (row.request_fingerprint !== fingerprint) {
    return {
      body: {
        status: 'error',
        error: 'Idempotency key reuse with different request payload',
        type: 'idempotency_key_mismatch',
      },
      status: 409,
    };
  }

  try {
    return { body: JSON.parse(row.response_body), status: row.response_status_code };
  } catch {
    return { body: { status: 'error', error: 'Invalid stored idempotency response' }, status: 500 };
  }
}
