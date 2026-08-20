#!/usr/bin/env node
/*
 * scan-drive-folder.mjs — build data/incidents.json from a shared Drive folder.
 *
 * No API key, no Google Cloud project. It uses two public endpoints that work
 * for any folder shared as "Anyone with the link":
 *
 *   1. embeddedfolderview  — lists the file IDs and names in the folder.
 *   2. usercontent download with an HTTP Range header — pulls only the few MB
 *      holding the moov atom, so a 640 MB recording costs a ~3 MB read.
 *
 * Why it reads the files at all: iPhone names recordings IMG_1234.MOV, which
 * contains no date. The real capture time is inside the file, in
 * com.apple.quicktime.creationdate, as local wall-clock time with the offset
 * the phone was set to. That is the moment the noise actually happened.
 *
 * Anything without a trustworthy capture time is DISCARDED, not guessed at.
 * A converted or re-encoded clip usually has its metadata stripped, and its
 * Drive upload date is just when it was uploaded — plotting that would put a
 * false incident on the calendar, which is worse than having no entry.
 *
 * Usage:
 *   node tools/scan-drive-folder.mjs                     # folder from js/config.js
 *   node tools/scan-drive-folder.mjs --folder <ID|URL>
 *   node tools/scan-drive-folder.mjs --out data/incidents.json
 *   node tools/scan-drive-folder.mjs --keep-untrusted    # include discards
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMoov, splitCreationDate } from './lib/qtmeta.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const arg = (name) => {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 ? process.argv[i + 1] : undefined;
};
const flag = (name) => process.argv.includes('--' + name);

/* Read the default folder out of js/config.js so there is one source of truth. */
function folderFromConfig() {
  try {
    const src = readFileSync(resolve(ROOT, 'js/config.js'), 'utf8');
    const m = /driveFolderId:\s*'([^']+)'/.exec(src);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function normalizeFolderId(value) {
  if (!value) return null;
  const m = /\/folders\/([a-zA-Z0-9_-]+)/.exec(value);
  return (m ? m[1] : String(value).trim()) || null;
}

const folderId = normalizeFolderId(arg('folder')) || folderFromConfig();
const outPath = resolve(ROOT, arg('out') || 'data/incidents.json');
const RANGE = 3_000_000;      // bytes of moov to pull per attempt
const BIG_RANGE = 16_000_000; // retry span when moov sits further in

if (!folderId) {
  console.error('No folder. Pass --folder <ID or URL>, or set driveFolderId in js/config.js.');
  process.exit(1);
}

/* ---------- 1. list the folder ---------- */

async function listFolder(id) {
  const res = await fetch(
    `https://drive.google.com/embeddedfolderview?id=${id}#list`
  );
  if (!res.ok) {
    throw new Error(
      `Could not read the folder (HTTP ${res.status}). It must be shared as ` +
      `"Anyone with the link -> Viewer".`
    );
  }
  const html = await res.text();
  const ids = [...html.matchAll(/id="entry-([A-Za-z0-9_-]{20,})"/g)].map((m) => m[1]);
  const names = [...html.matchAll(/flip-entry-title">([^<]*)<\/div>/g)].map((m) =>
    m[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  );
  return ids.map((fileId, i) => ({ id: fileId, name: names[i] || fileId }));
}

/* ---------- 2. read each file's metadata over HTTP Range ---------- */

const downloadUrl = (id, confirm) =>
  `https://drive.usercontent.google.com/download?id=${id}&export=download` +
  (confirm ? '&confirm=t' : '');

/* Large files return a "virus scan warning" page instead of bytes; retrying
 * with confirm=t is what a browser does when you click through it. */
async function resolveSize(id) {
  for (const confirm of [false, true]) {
    const res = await fetch(downloadUrl(id, confirm), { method: 'HEAD' });
    const type = res.headers.get('content-type') || '';
    const size = Number(res.headers.get('content-length') || 0);
    if (size > 100_000 && !type.startsWith('text/html')) {
      return { size, url: downloadUrl(id, confirm) };
    }
  }
  return null;
}

async function range(url, from, to) {
  const res = await fetch(url, { headers: { Range: `bytes=${from}-${to}` } });
  if (!res.ok && res.status !== 206) return null;
  return Buffer.from(await res.arrayBuffer());
}

/* moov sits at the end on iPhone recordings and at the front on files written
 * for streaming, so try the tail, then the head, then a wider tail. */
async function readMetadata(url, size) {
  const spans = [
    [Math.max(0, size - RANGE), size - 1],
    [0, Math.min(size, RANGE) - 1],
    [Math.max(0, size - BIG_RANGE), size - 1],
  ];
  for (const [from, to] of spans) {
    const buf = await range(url, from, to);
    if (!buf) continue;
    const meta = parseMoov(buf);
    if (meta.creationDate || meta.mvhdDate) return meta;
  }
  return null;
}

/* ---------- 3. decide whether the time can be trusted ---------- */

const MEDIA = /\.(mov|mp4|m4v|avi|mkv|jpe?g|png|heic)$/i;

function classify(meta) {
  if (!meta) {
    return { keep: false, reason: 'no readable metadata (likely converted or re-encoded)' };
  }
  if (meta.creationDate) {
    const split = splitCreationDate(meta.creationDate);
    if (split) {
      return {
        keep: true,
        captureTime: split.wallClock,
        captureOffset: split.offset,
        source: 'quicktime-creationdate',
      };
    }
  }
  // mvhd alone is weak: re-encoders overwrite it with the conversion time, so
  // it cannot be told apart from a real capture time. Discard rather than guess.
  if (meta.mvhdDate) {
    return {
      keep: false,
      reason: 'only an mvhd date, which re-encoding tools overwrite — not trustworthy',
      mvhd: meta.mvhdDate.toISOString(),
    };
  }
  return { keep: false, reason: 'no capture time in metadata' };
}

/* ---------- run ---------- */

console.log(`Reading folder ${folderId} …`);
const entries = await listFolder(folderId);
const media = entries.filter((e) => MEDIA.test(e.name));
console.log(`${entries.length} item(s), ${media.length} playable.\n`);

const kept = [];
const discarded = [];

for (const entry of media) {
  process.stdout.write(`  ${entry.name.padEnd(20)} `);
  let located = null;
  try {
    located = await resolveSize(entry.id);
  } catch (e) {
    /* fall through to the unreadable branch */
  }

  if (!located) {
    discarded.push({ ...entry, reason: 'could not download (sharing or size)' });
    console.log('DISCARD  could not download');
    continue;
  }

  const meta = await readMetadata(located.url, located.size);
  const verdict = classify(meta);

  if (!verdict.keep) {
    discarded.push({ ...entry, reason: verdict.reason, mvhd: verdict.mvhd || null });
    console.log(`DISCARD  ${verdict.reason}`);
    continue;
  }

  kept.push({
    id: entry.id,
    name: entry.name,
    mimeType: /\.(jpe?g|png|heic)$/i.test(entry.name) ? 'image/jpeg' : 'video/quicktime',
    sizeBytes: located.size,
    // Bare wall-clock string: the literal reading, no zone conversion.
    captureTime: verdict.captureTime,
    captureOffset: verdict.captureOffset,
    captureSource: verdict.source,
    durationMs: meta.durationSec ? Math.round(meta.durationSec * 1000) : null,
    device: [meta.make, meta.model].filter(Boolean).join(' ') || null,
    location: meta.location || null,
  });
  console.log(`${verdict.captureTime}  ${verdict.captureOffset || ''}`);
}

kept.sort((a, b) => a.captureTime.localeCompare(b.captureTime));

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      folderId,
      source: 'quicktime-metadata',
      files: flag('keep-untrusted') ? [...kept, ...discarded] : kept,
      discarded,
    },
    null,
    2
  ) + '\n'
);

console.log(`\nKept ${kept.length}, discarded ${discarded.length}.`);
if (discarded.length) {
  console.log('\nDiscarded — these carry no trustworthy capture time:');
  for (const d of discarded) console.log(`  ${d.name}: ${d.reason}`);
  console.log(
    '\nIf you still have the originals, re-upload them without converting and ' +
    'the capture time comes back. Otherwise add "captureTime" by hand in ' +
    `${arg('out') || 'data/incidents.json'}.`
  );
}
console.log(`\nWrote ${outPath}`);
