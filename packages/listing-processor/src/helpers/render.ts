// Template render helper using Eta.

import { Eta } from 'eta';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consumeFlash } from './flash.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..', '..');

export const eta = new Eta({
  views: join(ROOT, 'templates'),
  autoEscape: true,
  cache: process.env.NODE_ENV === 'production',
});

export function render(
  request: any,
  reply: any,
  template: string,
  data: Record<string, unknown> = {},
): string {
  const flashes = consumeFlash(request, reply);
  const activeNav = data.activeNav ?? '';
  const tplPath = template.startsWith('./') ? template : `./${template}`;
  return eta.render(tplPath, { ...data, flashes, activeNav });
}
