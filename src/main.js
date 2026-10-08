import '@fontsource-variable/schibsted-grotesk';
import './style.css';
import { zipSync } from 'fflate';
import { createPool, settingsKey } from './pool.js';
import { outputName, uniqueNames, formatBytes, formatSaving, percentSmaller } from './names.js';

// ---------- settings ----------

const DEFAULTS = {
  format: 'webp',
  mode: 'lossy',
  maxWidth: '',
  longEdge: false,
  prefix: '',
  suffix: '',
  lowercase: false,
  hyphens: false,
};
const STORE_KEY = 'compress.settings.v1';

const $ = (id) => document.getElementById(id);
const form = $('settings');
let settings = loadSettings();
writeForm(settings);

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(settings));
  } catch {
    // Private browsing or storage blocked: settings just won't be remembered.
  }
}

function readForm() {
  const fd = new FormData(form);
  return {
    format: fd.get('format') || DEFAULTS.format,
    mode: fd.get('mode') || DEFAULTS.mode,
    maxWidth: (fd.get('maxWidth') || '').toString().trim(),
    longEdge: fd.has('longEdge'),
    prefix: (fd.get('prefix') || '').toString(),
    suffix: (fd.get('suffix') || '').toString(),
    lowercase: fd.has('lowercase'),
    hyphens: fd.has('hyphens'),
  };
}

function writeForm(s) {
  for (const el of form.elements) {
    if (!el.name || !(el.name in s)) continue;
    if (el.type === 'radio') el.checked = el.value === s[el.name];
    else if (el.type === 'checkbox') el.checked = Boolean(s[el.name]);
    else el.value = s[el.name];
  }
}

function compressionSettings() {
  const { format, mode, maxWidth, longEdge } = settings;
  return { format, mode, maxWidth, longEdge };
}

const MODE_HINTS = {
  'original|lossy': 'JPG and WebP at quality 80. PNG reduced to 256 colours.',
  'original|lossless': 'PNG and WebP stay pixel perfect. JPG has no lossless mode, so it saves at quality 92 and keeps the original if that is no smaller.',
  'webp|lossy': 'Quality 80. Usually the smallest file for photos.',
  'webp|lossless': 'Pixel perfect. Best for graphics and screenshots, large for photos.',
  'jpg|lossy': 'Quality 80 with MozJPEG. Transparent areas become white.',
  'jpg|lossless': 'JPG has no lossless mode, so this saves at quality 92. Transparent areas become white.',
  'png|lossy': 'Reduced to 256 colours. Great for graphics, can band on photos.',
  'png|lossless': 'Pixel perfect, with the file structure optimised.',
};

function renderSettingsUI() {
  $('mode-hint').textContent = MODE_HINTS[`${settings.format}|${settings.mode}`] || '';
  $('max-label').textContent = settings.longEdge ? 'Max long edge' : 'Max width';

  const renaming = settings.prefix || settings.suffix || settings.lowercase || settings.hyphens;
  const preview = $('rename-preview');
  if (!renaming) {
    preview.textContent = 'Original names are kept.';
    return;
  }
  const example = items.find((i) => i.result) || items[0];
  const sample = example?.file.name || 'Studio Shoot 04.jpg';
  const ext = example?.result?.ext || (settings.format === 'original' ? sample.split('.').pop().toLowerCase() : settings.format);
  preview.replaceChildren(
    document.createTextNode(`${sample} becomes `),
    Object.assign(document.createElement('strong'), { textContent: outputName(sample, ext, settings) }),
  );
}

form.addEventListener('input', () => {
  settings = readForm();
  saveSettings();
  renderSettingsUI();
  refreshNames();
  for (const item of items) renderItem(item);
  renderStale();
});
form.addEventListener('submit', (e) => e.preventDefault());

// ---------- queue ----------

const items = [];
let nextId = 1;
const listEl = $('files');

const pool = createPool({
  size: Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1)),
  getSettings: compressionSettings,
  onStart(item) {
    item.status = 'working';
    renderItem(item);
    renderTotals();
  },
  onDone(item, data) {
    if (!items.includes(item)) return;
    if (data.ok) {
      releaseResult(item);
      const blob = new Blob([data.buffer], { type: data.mime });
      item.result = {
        blob,
        url: URL.createObjectURL(blob),
        thumbUrl: data.thumb ? URL.createObjectURL(data.thumb) : null,
        ext: data.ext,
        width: data.width,
        height: data.height,
        srcWidth: data.srcWidth,
        srcHeight: data.srcHeight,
        kept: data.kept,
      };
      item.status = 'done';
      item.error = null;
    } else {
      item.status = 'error';
      item.error = data.error;
    }
    refreshNames();
    for (const other of items) if (other.status === 'done') renderName(other);
    renderItem(item);
    renderTotals();
    renderStale();
    renderSettingsUI();
  },
});

const IMAGE_EXT = /\.(jpe?g|jfif|png|webp|avif|gif|heic|heif|bmp|svg)$/i;

function addFiles(files) {
  const accepted = files
    .filter((f) => !f.name.startsWith('.') && (f.type.startsWith('image/') || IMAGE_EXT.test(f.name)))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  for (const file of accepted) {
    const item = { id: nextId++, file, status: 'queued', result: null, error: null, key: null, outName: file.name };
    items.push(item);
    createRow(item);
    pool.add(item);
  }
  renderLayout();
  renderTotals();
  renderSettingsUI();
}

function removeItem(item) {
  pool.cancel(item);
  releaseResult(item);
  if (item.originalUrl) URL.revokeObjectURL(item.originalUrl);
  item.el.remove();
  items.splice(items.indexOf(item), 1);
  refreshNames();
  renderLayout();
  renderTotals();
  renderStale();
  renderSettingsUI();
}

function clearAll() {
  for (const item of [...items]) removeItem(item);
}

function releaseResult(item) {
  if (!item.result) return;
  URL.revokeObjectURL(item.result.url);
  if (item.result.thumbUrl) URL.revokeObjectURL(item.result.thumbUrl);
  item.result = null;
}

// Output names depend on rename settings, and must be unique across the batch.
function refreshNames() {
  const named = items.filter((i) => i.result);
  const unique = uniqueNames(named.map((i) => outputName(i.file.name, i.result.ext, settings)));
  named.forEach((item, n) => (item.outName = unique[n]));
}

function staleItems() {
  const key = settingsKey(compressionSettings());
  return items.filter((i) => i.status !== 'queued' && i.key && i.key !== key);
}

function recompressStale() {
  for (const item of staleItems()) {
    pool.cancel(item);
    item.status = 'queued';
    item.error = null;
    renderItem(item);
    pool.add(item);
  }
  renderStale();
  renderTotals();
}

// ---------- rendering ----------

const ICON_REMOVE =
  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

function createRow(item) {
  const li = document.createElement('li');
  li.className = 'file';
  li.innerHTML = `
    <div class="thumb"><img alt="" decoding="async" hidden /></div>
    <div class="meta">
      <p class="name"></p>
      <p class="detail"></p>
    </div>
    <div class="size">
      <p class="size-figures"></p>
      <div class="bar" aria-hidden="true"><span></span></div>
    </div>
    <p class="saving"></p>
    <div class="actions">
      <button type="button" class="button small" data-action="compare">Compare</button>
      <a class="button small" data-action="download">Download</a>
      <button type="button" class="icon-button" data-action="remove" aria-label="Remove">${ICON_REMOVE}</button>
    </div>`;
  li.item = item;
  item.el = li;
  listEl.append(li);
  renderItem(item);
}

function renderName(item) {
  const el = item.el.querySelector('.name');
  el.textContent = item.result ? item.outName : item.file.name;
  el.title = item.file.name;
  const link = item.el.querySelector('[data-action="download"]');
  if (item.result) link.download = item.outName;
}

function renderItem(item) {
  const el = item.el;
  const r = item.result;
  const hasResult = Boolean(r) && item.status !== 'error';
  el.dataset.status = item.status;

  renderName(item);

  const thumb = el.querySelector('.thumb img');
  if (hasResult) {
    const src = r.thumbUrl || r.url;
    if (thumb.getAttribute('src') !== src) thumb.src = src;
    thumb.hidden = false;
  } else {
    thumb.hidden = true;
    thumb.removeAttribute('src');
  }

  const detail = el.querySelector('.detail');
  detail.classList.toggle('error', item.status === 'error');
  if (item.status === 'error') detail.textContent = item.error;
  else if (item.status === 'working') detail.textContent = 'Compressing';
  else if (item.status === 'queued') detail.textContent = r ? 'Waiting to recompress' : 'Waiting';
  else detail.textContent = describe(item);

  const figures = el.querySelector('.size-figures');
  const bar = el.querySelector('.bar span');
  const saving = el.querySelector('.saving');
  if (hasResult) {
    figures.innerHTML = `<strong>${formatBytes(r.blob.size)}</strong> <span>from ${formatBytes(item.file.size)}</span>`;
    bar.style.setProperty('--ratio', Math.min(1, r.blob.size / item.file.size).toFixed(4));
    saving.textContent = formatSaving(item.file.size, r.blob.size);
    saving.classList.toggle('worse', r.blob.size > item.file.size);
  } else {
    figures.innerHTML = `<span>${formatBytes(item.file.size)}</span>`;
    bar.style.setProperty('--ratio', 1);
    saving.textContent = '';
  }

  el.querySelector('[data-action="compare"]').disabled = !hasResult;
  const link = el.querySelector('[data-action="download"]');
  if (hasResult) {
    link.href = r.url;
    link.removeAttribute('aria-disabled');
  } else {
    link.removeAttribute('href');
    link.setAttribute('aria-disabled', 'true');
  }
}

function describe(item) {
  const r = item.result;
  const dims =
    r.width !== r.srcWidth || r.height !== r.srcHeight
      ? `${r.srcWidth} × ${r.srcHeight} resized to ${r.width} × ${r.height}`
      : `${r.width} × ${r.height}`;
  if (r.kept) return `${dims}. Already as small as it gets, so the original is kept.`;
  return dims;
}

function renderLayout() {
  $('drop').toggleAttribute('data-empty', items.length === 0);
  $('totals').hidden = items.length === 0;
}

function renderTotals() {
  if (!items.length) return;
  const done = items.filter((i) => i.status === 'done');
  const failed = items.filter((i) => i.status === 'error').length;
  const pending = items.length - done.length - failed;

  const count = $('totals-count');
  const failNote = failed ? `, ${failed} failed` : '';
  count.textContent = pending
    ? `${done.length} of ${items.length} done${failNote}`
    : `${items.length} ${items.length === 1 ? 'image' : 'images'}${failNote}`;

  const before = done.reduce((sum, i) => sum + i.file.size, 0);
  const after = done.reduce((sum, i) => sum + i.result.blob.size, 0);
  const size = $('totals-size');
  if (done.length) {
    const pct = percentSmaller(before, after);
    const verdict = pct > 0 ? `${pct}% smaller` : pct < 0 ? `${Math.abs(pct)}% larger` : 'Same size';
    size.innerHTML = `<strong>${verdict}</strong> <span>${formatBytes(before)} to ${formatBytes(after)}</span>`;
  } else {
    size.textContent = '';
  }

  $('download-all').disabled = done.length === 0;
}

function renderStale() {
  $('stale').hidden = staleItems().length === 0;
}

// ---------- adding files ----------

$('pick-files').addEventListener('click', () => $('file-input').click());
$('pick-folder').addEventListener('click', () => $('folder-input').click());
for (const id of ['file-input', 'folder-input']) {
  $(id).addEventListener('change', (e) => {
    addFiles([...e.target.files]);
    e.target.value = '';
  });
}

const overlay = $('dropping');
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth += 1;
  overlay.hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) overlay.hidden = true;
});
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  overlay.hidden = true;
  addFiles(await filesFromDrop(e.dataTransfer));
});

document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) addFiles(files);
});

// Folders arrive as directory entries, so walk them for the files inside.
async function filesFromDrop(dt) {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [];
  for (const entry of entries) await walk(entry, out);
  return out;
}

async function walk(entry, out) {
  if (entry.isFile) {
    out.push(await new Promise((resolve, reject) => entry.file(resolve, reject)));
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      for (const child of batch) await walk(child, out);
    } while (batch.length);
  }
}

// ---------- list actions ----------

listEl.addEventListener('click', (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  const item = target.closest('.file').item;
  const action = target.dataset.action;
  if (action === 'remove') removeItem(item);
  if (action === 'compare' && item.result) openCompare(item);
  if (action === 'download' && !item.result) e.preventDefault();
});

$('recompress').addEventListener('click', recompressStale);
$('clear').addEventListener('click', clearAll);
$('download-all').addEventListener('click', downloadAll);

async function downloadAll() {
  const done = items.filter((i) => i.status === 'done' && i.result);
  if (!done.length) return;
  const button = $('download-all');
  button.disabled = true;
  button.textContent = 'Zipping';
  try {
    const files = {};
    for (const item of done) {
      files[item.outName] = [new Uint8Array(await item.result.blob.arrayBuffer()), { level: 0 }];
    }
    const zipped = zipSync(files);
    const stamp = new Date().toISOString().slice(0, 10);
    save(new Blob([zipped], { type: 'application/zip' }), `compressed-${stamp}.zip`);
  } finally {
    button.textContent = 'Download all';
    button.disabled = false;
  }
}

function save(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---------- compare ----------

const dialog = $('compare');
const frame = $('compare-frame');
const range = $('compare-range');
const beforeImg = $('compare-before');
const afterImg = $('compare-after');

function openCompare(item) {
  const r = item.result;
  item.originalUrl ??= URL.createObjectURL(item.file);
  $('compare-missing').hidden = true;
  beforeImg.src = item.originalUrl;
  afterImg.src = r.url;
  frame.style.setProperty('--w', r.width);
  frame.style.setProperty('--h', r.height);
  $('compare-title').textContent = item.outName;
  $('compare-sizes').textContent = `${formatBytes(item.file.size)} to ${formatBytes(r.blob.size)}, ${formatSaving(item.file.size, r.blob.size)}`;
  dialog.querySelector('input[name="zoom"][value="fit"]').checked = true;
  dialog.dataset.zoom = 'fit';
  setPosition(50);
  dialog.showModal();
  range.focus();
}

beforeImg.addEventListener('error', () => {
  if (beforeImg.getAttribute('src')) $('compare-missing').hidden = false;
});

function setPosition(pct) {
  const clamped = Math.min(100, Math.max(0, pct));
  frame.style.setProperty('--pos', `${clamped}%`);
  range.value = clamped;
}

range.addEventListener('input', () => setPosition(Number(range.value)));

let dragging = false;
frame.addEventListener('pointerdown', (e) => {
  dragging = true;
  frame.setPointerCapture(e.pointerId);
  moveTo(e);
});
frame.addEventListener('pointermove', (e) => dragging && moveTo(e));
frame.addEventListener('pointerup', () => (dragging = false));
frame.addEventListener('pointercancel', () => (dragging = false));

function moveTo(e) {
  const rect = frame.getBoundingClientRect();
  setPosition(((e.clientX - rect.left) / rect.width) * 100);
}

dialog.addEventListener('change', (e) => {
  if (e.target.name === 'zoom') dialog.dataset.zoom = e.target.value;
});
$('compare-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => {
  beforeImg.removeAttribute('src');
  afterImg.removeAttribute('src');
});
// Click on the dark backdrop closes it.
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) dialog.close();
});

renderSettingsUI();
renderLayout();
