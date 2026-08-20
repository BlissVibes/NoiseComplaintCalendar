#!/usr/bin/env node
/*
 * fetch-drive-metadata.mjs
 *
 * Reads a Google Drive folder and writes data/incidents.json — the file the
 * website loads. Run this locally whenever you add new recordings, then
 * commit the result. The API key stays on your machine and never reaches the
 * published site.
 *
 * Usage:
 *   node tools/fetch-drive-metadata.mjs --folder <FOLDER_ID> --key <API_KEY>
 *
 * Or set them once in your shell and just run the script:
 *   export DRIVE_FOLDER_ID=1AbCdEf...
 *   export DRIVE_API_KEY=AIza...
 *   node tools/fetch-drive-metadata.mjs
 *
 * The folder must be shared "Anyone with the link -> Viewer" for an API key
 * to read it. That is also what lets the videos play on the published page.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const FIELDS =
  'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,' +
  'webViewLink,thumbnailLink,videoMediaMetadata,imageMediaMetadata)';

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

// Accept a full Drive URL or a bare ID.
function normalizeFolderId(value) {
  if (!value) return value;
  const m = /\/folders\/([a-zA-Z0-9_-]+)/.exec(value);
  return m ? m[1] : value.trim();
}

const folderId = normalizeFolderId(arg('folder') || process.env.DRIVE_FOLDER_ID);
const apiKey = arg('key') || process.env.DRIVE_API_KEY;
const outPath = resolve(ROOT, arg('out') || 'data/incidents.json');

if (!folderId || !apiKey) {
  console.error(`
Missing credentials.

  node tools/fetch-drive-metadata.mjs --folder <FOLDER_ID> --key <API_KEY>

FOLDER_ID is the last part of the folder URL:
  https://drive.google.com/drive/folders/1AbCdEf_GhIjK  ->  1AbCdEf_GhIjK

See README.md for how to create an API key (about five minutes, free).
`);
  process.exit(1);
}

async function listFolder(id) {
  const files = [];
  let pageToken;

  do {
    const params = new URLSearchParams({
      q: `'${id}' in parents and trashed = false`,
      key: apiKey,
      fields: FIELDS,
      pageSize: '1000',
      orderBy: 'name',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`);
    const json = await res.json();

    if (!res.ok) {
      const msg = json?.error?.message || `HTTP ${res.status}`;
      throw new Error(
        `Google Drive rejected the request: ${msg}\n` +
        `Check that the folder is shared "Anyone with the link" and that the ` +
        `API key has the Drive API enabled.`
      );
    }

    for (const file of json.files || []) {
      // Recurse into subfolders so a folder-per-month layout still works.
      if (file.mimeType === 'application/vnd.google-apps.folder') {
        files.push(...await listFolder(file.id));
      } else {
        files.push(file);
      }
    }
    pageToken = json.nextPageToken;
  } while (pageToken);

  return files;
}

const all = await listFolder(folderId);

// Keep only playable media; ignore stray docs, notes, thumbnails.
const media = all.filter(
  (f) => f.mimeType?.startsWith('video/') || f.mimeType?.startsWith('image/')
);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify(
    { generatedAt: new Date().toISOString(), folderId, files: media },
    null,
    2
  ) + '\n'
);

const skipped = all.length - media.length;
console.log(`Wrote ${media.length} recordings to ${outPath}`);
if (skipped > 0) console.log(`Ignored ${skipped} non-media file(s).`);
console.log('\nNext: git add data/incidents.json && git commit && git push');
