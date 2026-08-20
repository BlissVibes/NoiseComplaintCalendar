#!/usr/bin/env node
/*
 * scan-drive-folder.mjs — build data/incidents.json from a shared Drive folder.
 *
 * Listing the folder works two ways, and the scan picks whichever is available:
 *
 *   public (default)  embeddedfolderview, which needs no API key at all and
 *                     works for any folder shared "Anyone with the link".
 *   api               Drive's files.list, used when an API key is supplied.
 *                     Slower to set up but it pages properly, walks
 *                     subfolders, and returns Drive's own fields.
 *
 * Either way the capture time comes from the same place — inside the video —
 * read with an HTTP Range request that pulls only the few MB holding the moov
 * atom, so a 640 MB recording costs a ~3 MB read. Switching listing method
 * never changes a timestamp.
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
 *   node tools/scan-drive-folder.mjs --key <API_KEY>     # list via Drive API
 *   node tools/scan-drive-folder.mjs --method public     # force either mode
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

/* Accepts one folder, or several comma-separated, so an older folder can be
 * merged in rather than losing the incidents it holds. */
const folderIds = (arg('folder') || folderFromConfig() || '')
  .split(',')
  .map((v) => normalizeFolderId(v.trim()))
  .filter(Boolean);
const folderId = folderIds[0];
const outPath = resolve(ROOT, arg('out') || 'data/incidents.json');

/* A key is optional. Given one, listing goes through the Drive API; without,
 * through the public folder view. --method forces either regardless. */
const apiKey = arg('key') || process.env.DRIVE_API_KEY || null;
const methodForced = !!arg('method');
let method = arg('method') || (apiKey ? 'api' : 'public');

if (method === 'api' && !apiKey) {
  console.error('--method api needs --key <API_KEY> or the DRIVE_API_KEY env var.');
  process.exit(1);
}
const RANGE = 3_000_000;      // bytes of moov to pull per attempt
const BIG_RANGE = 16_000_000; // retry span when moov sits further in

if (!folderIds.length) {
  console.error('No folder. Pass --folder <ID or URL>, or set driveFolderId in js/config.js.');
  process.exit(1);
}

/* ---------- 1. list the folder ---------- */

async function listFolder(id) {
  return method === 'api' ? listFolderApi(id) : listFolderPublic(id);
}

/* Drive's own listing. Pages through results and walks subfolders, so a
 * folder-per-month layout works and a large folder is never truncated. */
async function listFolderApi(id) {
  const out = [];
  let pageToken;

  do {
    const params = new URLSearchParams({
      q: `'${id}' in parents and trashed = false`,
      key: apiKey,
      fields: 'nextPageToken,files(id,name,mimeType,size,createdTime)',
      pageSize: '1000',
      orderBy: 'name',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`);
    const json = await res.json();
    if (!res.ok) {
      throw new Error(
        `Drive API: ${json?.error?.message || 'HTTP ' + res.status}`
      );
    }
    for (const file of json.files || []) {
      if (file.mimeType === 'application/vnd.google-apps.folder') {
        out.push(...await listFolderApi(file.id));
      } else {
        out.push({ id: file.id, name: file.name, driveSize: Number(file.size) || null });
      }
    }
    pageToken = json.nextPageToken;
  } while (pageToken);

  return out;
}

/* The keyless listing. It returns one flat page, so a very large folder can
 * come back short — worth saying so rather than silently under-reporting. */
async function listFolderPublic(id) {
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
  const listed = ids.map((fileId, i) => ({ id: fileId, name: names[i] || fileId }));
  if (listed.length >= 100) {
    console.warn(
      `  ! ${listed.length} items returned by the keyless listing. That endpoint ` +
      `does not page,\n    so a larger folder may be cut short. Re-run with ` +
      `--key <API_KEY> to be certain.`
    );
  }
  return listed;
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

/* Any failure from here on is an operational problem — a folder that is not
 * shared, a key without the API enabled — not a bug worth a stack trace. */
process.on('uncaughtException', (err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});

/* ---------- run ---------- */

/* Independent check on the metadata. When the filename also carries a date —
 * as Apple's "IMG_0040 - 06-07-2026 12.50 AM.mov" exports do — the two should
 * agree. A disagreement means one of them is wrong, which is exactly the case
 * worth surfacing rather than silently trusting. */
function filenameDate(name) {
  const m = /(\d{2})-(\d{2})-(\d{4})[\s_]+(\d{1,2})[.:_](\d{2})\s*([AaPp])\.?[Mm]\.?/
    .exec(name);
  if (!m) return null;
  let hour = Number(m[4]) % 12;
  if (/[Pp]/.test(m[6])) hour += 12;
  return `${m[3]}-${m[1]}-${m[2]} ${String(hour).padStart(2, '0')}:${m[5]}`;
}

/* Listing is the only step the two methods differ on, so a key that turns out
 * to be wrong should not sink the whole scan — unless the method was asked for
 * explicitly, in which case silently doing something else would be worse. */
async function listWithFallback(id) {
  try {
    return await listFolder(id);
  } catch (err) {
    if (methodForced || method !== 'api') throw err;
    console.warn(`  ! Drive API listing failed: ${err.message.split('\n')[0]}`);
    console.warn('    Falling back to the keyless public listing.');
    method = 'public';
    return listFolder(id);
  }
}

const entries = [];
for (const id of folderIds) {
  console.log(`Reading folder ${id} (${method} listing) …`);
  const found = await listWithFallback(id);
  // Later folders never displace an entry already seen.
  for (const e of found) {
    if (!entries.some((x) => x.id === e.id)) entries.push(e);
  }
}
const media = entries.filter((e) => MEDIA.test(e.name));
console.log(`${entries.length} item(s), ${media.length} playable.\n`);

const mismatches = [];

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
  const claimed = filenameDate(entry.name);
  if (claimed && claimed !== verdict.captureTime.slice(0, 16)) {
    mismatches.push({
      name: entry.name,
      filename: claimed,
      metadata: verdict.captureTime.slice(0, 16),
    });
    console.log(`${verdict.captureTime}  ⚠ filename says ${claimed}`);
  } else {
    console.log(`${verdict.captureTime}  ${verdict.captureOffset || ''}` +
      (claimed ? '  (filename agrees)' : ''));
  }
}

/* The same recording can appear in more than one folder — re-uploaded under a
 * new name, so it has a different Drive ID and the ID-based dedupe above
 * misses it. Capture time to the second is what actually identifies a
 * recording. Prefer the copy whose filename carries a date, since that one
 * can be cross-checked against its own metadata. */
function dedupeByCaptureTime(list) {
  const best = new Map();
  const dropped = [];
  for (const item of list) {
    // Capture time to the second identifies a recording, because one camera
    // cannot begin two recordings in the same second. (All of these come from
    // a single iPhone; revisit this if a second device is ever added.)
    //
    // Byte size deliberately plays no part. The same clip re-uploaded is often
    // re-encoded — 47 MB against 199 MB for one July 14 recording — while its
    // duration stays put to within a millisecond. Matching on size would treat
    // those as two separate incidents and double-count the night.
    const key = item.captureTime;
    const existing = best.get(key);
    if (!existing) {
      best.set(key, item);
      continue;
    }
    const winner = preferred(item, existing);
    const loser = winner === item ? existing : item;
    best.set(key, winner);
    dropped.push({
      name: loser.name,
      duplicateOf: winner.name,
      at: loser.captureTime,
      droppedSize: loser.sizeBytes,
      keptSize: winner.sizeBytes,
    });
  }
  return { unique: [...best.values()], dropped };
}

/* Which copy of a duplicated recording to keep: one whose filename carries a
 * date can be cross-checked, so it wins; failing that keep the longest, then
 * the largest, since a trimmed or heavily compressed copy shows less of the
 * incident. */
function preferred(a, b) {
  const aDated = !!filenameDate(a.name);
  const bDated = !!filenameDate(b.name);
  if (aDated !== bDated) return aDated ? a : b;
  if ((a.durationMs || 0) !== (b.durationMs || 0)) {
    return (a.durationMs || 0) > (b.durationMs || 0) ? a : b;
  }
  return (a.sizeBytes || 0) >= (b.sizeBytes || 0) ? a : b;
}

const { unique, dropped: duplicates } = dedupeByCaptureTime(kept);
kept.length = 0;
kept.push(...unique);
kept.sort((a, b) => a.captureTime.localeCompare(b.captureTime));

if (duplicates.length) {
  console.log(`\nMerged ${duplicates.length} duplicate(s) — same recording in more than one folder:`);
  for (const d of duplicates) console.log(`  ${d.name}  ==  ${d.duplicateOf}  (${d.at})`);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      folderId,
      folderIds,
      source: 'quicktime-metadata',
      listing: method,
      mismatches,
      duplicates,
      files: flag('keep-untrusted') ? [...kept, ...discarded] : kept,
      discarded,
    },
    null,
    2
  ) + '\n'
);

console.log(`\nKept ${kept.length}, discarded ${discarded.length}.`);

const crosschecked = kept.filter((k) => filenameDate(k.name)).length;
if (crosschecked) {
  console.log(
    `${crosschecked} filename(s) also carried a date; ` +
    `${crosschecked - mismatches.length} agreed with the file's own metadata.`
  );
}
if (mismatches.length) {
  console.log('\nMISMATCH — filename and metadata disagree, check these by hand:');
  for (const m of mismatches) {
    console.log(`  ${m.name}\n      filename: ${m.filename}\n      metadata: ${m.metadata}`);
  }
}
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
