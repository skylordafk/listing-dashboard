import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';

/** Load Upload API key from env, config dir, legacy file, or generate. */
export function loadApiKey(): string {
  if (process.env.UPLOAD_API_KEY) return process.env.UPLOAD_API_KEY;

  const keyPaths = [
    join(process.cwd(), 'config', 'upload-api.key'),
    join(process.cwd(), '.api-key'),
    join(homedir(), 'ebay-upload-api', '.api-key'),
  ];

  for (const p of keyPaths) {
    if (existsSync(p)) {
      const k = readFileSync(p, 'utf-8').trim();
      if (k) return k;
    }
  }

  const newKey = randomBytes(24).toString('hex');
  console.log(`No API key found. Generated: ${newKey}`);
  return newKey;
}
