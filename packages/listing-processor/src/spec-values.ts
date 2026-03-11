// Canonical eBay spec-value maps — single source of truth.
// Used by both normalizer.ts (value normalization) and field-mapper.ts (Odoo → eBay mapping).

// ── RAM ─────────────────────────────────────────────────────────────
// Keys: compact lowercase (e.g. "4gb"). Values: eBay display format.
export const RAM_VALUES: Record<string, string> = {
  '1gb': '1 GB', '2gb': '2 GB', '4gb': '4 GB',
  '8gb': '8 GB', '16gb': '16 GB', '24gb': '24 GB',
  '32gb': '32 GB', '64gb': '64 GB', '128gb': '128 GB',
};

// ── Storage Type ────────────────────────────────────────────────────
// Normalizer keys: lowercase eBay-style strings.
export const STORAGE_TYPE_VALUES: Record<string, string> = {
  'ssd': 'SSD (Solid State Drive)',
  'nvme': 'NVMe (Non-Volatile Memory Express)',
  'nvme ssd': 'NVMe (Non-Volatile Memory Express)',
  'nvme (non-volatile memory express)': 'NVMe (Non-Volatile Memory Express)',
  'hdd': 'HDD (Hard Disk Drive)',
  'hdd (hard disk drive)': 'HDD (Hard Disk Drive)',
  'emmc': 'eMMC',
  'hdd+ssd': 'HDD + SSD',
  'hdd + ssd': 'HDD + SSD',
  'hdd_ssd': 'HDD + SSD',
  'sshd': 'SSHD (Solid State Hybrid Drive)',
  'ssd (solid state drive)': 'SSD (Solid State Drive)',
  'sshd (solid state hybrid drive)': 'SSHD (Solid State Hybrid Drive)',
};

// ── Graphics Processing Type ────────────────────────────────────────
export const GRAPHICS_TYPE_VALUES: Record<string, string> = {
  'integrated': 'Integrated/On-Board Graphics',
  'integrated/on-board graphics': 'Integrated/On-Board Graphics',
  'dedicated': 'Dedicated/Discrete Graphics',
  'dedicated/discrete': 'Dedicated/Discrete Graphics',
  'dedicated/discrete graphics': 'Dedicated/Discrete Graphics',
};

// ── Laptop Type ─────────────────────────────────────────────────────
export const TYPE_VALUES: Record<string, string> = {
  'notebook': 'Notebook/Laptop',
  'laptop': 'Notebook/Laptop',
  'notebook/laptop': 'Notebook/Laptop',
  'convertible': '2-in-1 Laptop/Tablet',
  '2 in 1 laptop': '2-in-1 Laptop/Tablet',
  '2-in-1': '2-in-1 Laptop/Tablet',
};
