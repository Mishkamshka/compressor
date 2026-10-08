// File naming and size formatting.

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

export function outputName(originalName, ext, s) {
  let stem = originalName.replace(/\.[^./]+$/, '');
  stem = `${s.prefix || ''}${stem}${s.suffix || ''}`.replace(ILLEGAL, '');
  if (s.hyphens) stem = stem.trim().replace(/\s+/g, '-');
  if (s.lowercase) stem = stem.toLowerCase();
  return `${stem || 'image'}.${ext}`;
}

// Make every name in a batch unique (case-insensitive, as macOS and Windows treat it).
export function uniqueNames(names) {
  const taken = new Set();
  return names.map((name) => {
    const dot = name.lastIndexOf('.');
    const stem = name.slice(0, dot);
    const ext = name.slice(dot);
    let candidate = name;
    let n = 1;
    while (taken.has(candidate.toLowerCase())) candidate = `${stem}-${++n}${ext}`;
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

// Decimal units, matching what Finder shows.
export function formatBytes(bytes) {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000 ** 2) return `${round(bytes / 1000)} KB`;
  if (bytes < 1000 ** 3) return `${round(bytes / 1000 ** 2)} MB`;
  return `${round(bytes / 1000 ** 3)} GB`;
}

function round(n) {
  return n >= 100 ? Math.round(n).toString() : n.toFixed(1).replace(/\.0$/, '');
}

export function formatSaving(original, output) {
  if (!original) return '0%';
  const change = percentSmaller(original, output);
  if (change > 0) return `−${change}%`;
  if (change < 0) return `+${Math.abs(change)}%`;
  return '0%';
}

// Rounded, but never claims 100% smaller for a file that still has bytes in it.
export function percentSmaller(original, output) {
  const change = Math.round((1 - output / original) * 100);
  return output > 0 ? Math.min(change, 99) : change;
}
