#!/usr/bin/env node
/*
 * parse-drive-links.mjs
 *
 * The no-API-key fallback. If you would rather not set up a Google Cloud key,
 * paste your Drive share links into a text file and run this instead.
 *
 * Each line should carry the filename and the share link, in either order,
 * separated by a tab, comma, or spaces:
 *
 *   PXL_20250523_225601123.mp4    https://drive.google.com/file/d/1AbC.../view
 *   https://drive.google.com/file/d/1XyZ.../view, PXL_20250524_231902441.mp4
 *
 * The filename matters: that is where the recording's real capture time comes
 * from. A link on its own gives us an ID but no date.
 *
 * Usage:
 *   node tools/parse-drive-links.mjs links.txt
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const input = process.argv[2];
if (!input) {
  console.error('Usage: node tools/parse-drive-links.mjs <links.txt> [--out data/incidents.json]');
  process.exit(1);
}

const outIndex = process.argv.indexOf('--out');
const outPath = resolve(ROOT, outIndex !== -1 ? process.argv[outIndex + 1] : 'data/incidents.json');

const ID_RE = /(?:\/file\/d\/|[?&]id=)([a-zA-Z0-9_-]{10,})/;
const BARE_ID_RE = /^[a-zA-Z0-9_-]{20,}$/;

const files = [];
const problems = [];

readFileSync(input, 'utf8').split(/\r?\n/).forEach((line, index) => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return;

  // Split on tabs/commas first; fall back to runs of spaces.
  const parts = trimmed.split(/\t|,|\s{2,}/).map((p) => p.trim()).filter(Boolean);
  const tokens = parts.length > 1 ? parts : trimmed.split(/\s+/);

  let id = null;
  let name = null;

  for (const token of tokens) {
    const m = ID_RE.exec(token);
    if (m) { id = m[1]; continue; }
    if (!id && BARE_ID_RE.test(token) && !/\.[a-z0-9]{2,4}$/i.test(token)) {
      id = token;
      continue;
    }
    if (!name && !/^https?:/i.test(token)) name = token;
  }

  if (!id) {
    problems.push(`line ${index + 1}: no Drive file ID found — ${trimmed.slice(0, 60)}`);
    return;
  }
  if (!name) {
    problems.push(`line ${index + 1}: no filename, so the date is unknown — ${trimmed.slice(0, 60)}`);
    return;
  }

  files.push({
    id,
    name,
    mimeType: /\.(jpe?g|png|heic)$/i.test(name) ? 'image/jpeg' : 'video/mp4',
  });
});

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify({ generatedAt: new Date().toISOString(), files }, null, 2) + '\n'
);

console.log(`Wrote ${files.length} recordings to ${outPath}`);
if (problems.length) {
  console.log(`\n${problems.length} line(s) skipped:`);
  problems.forEach((p) => console.log('  ' + p));
}
