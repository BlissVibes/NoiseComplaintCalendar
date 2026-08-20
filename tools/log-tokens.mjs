#!/usr/bin/env node
/*
 * log-tokens.mjs — append an entry to TOKENS.md.
 *
 * Claude Code sessions report a remaining-token budget. Pass the budget at the
 * start and end of a session and this works out what the session cost, then
 * rewrites the running totals at the top of the file.
 *
 * Usage:
 *   node tools/log-tokens.mjs --spent 122982 --note "Built the calendar"
 *   node tools/log-tokens.mjs --start 15000000 --end 14877018 --note "..."
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = resolve(ROOT, 'TOKENS.md');

const arg = (n) => {
  const i = process.argv.indexOf('--' + n);
  return i !== -1 ? process.argv[i + 1] : undefined;
};

const start = Number(arg('start'));
const end = Number(arg('end'));
const spent = arg('spent') ? Number(arg('spent')) : (start - end);
const note = arg('note') || 'Unlogged work';
const date = arg('date') || new Date().toISOString().slice(0, 10);

if (!Number.isFinite(spent) || spent <= 0) {
  console.error('Need --spent <n>, or both --start <n> and --end <n>.');
  process.exit(1);
}

if (!existsSync(LOG)) {
  console.error('TOKENS.md not found. Create it first.');
  process.exit(1);
}

const fmt = (n) => n.toLocaleString('en-US');
const lines = readFileSync(LOG, 'utf8').split('\n');

// Find the session table and work out the next session number.
const headerIndex = lines.findIndex((l) => l.startsWith('| # | Date |'));
if (headerIndex === -1) {
  console.error('Could not find the session table in TOKENS.md.');
  process.exit(1);
}

let lastRow = headerIndex + 1;
let sessions = 0;
let total = 0;
while (lastRow + 1 < lines.length && lines[lastRow + 1].startsWith('|')) {
  lastRow++;
  sessions++;
  const cells = lines[lastRow].split('|').map((c) => c.trim());
  // Columns: | # | Date | Work | Tokens | Cumulative |  -> tokens is cells[4]
  total += Number(cells[4].replace(/,/g, '')) || 0;
}

total += spent;
sessions++;

lines.splice(lastRow + 1, 0,
  `| ${sessions} | ${date} | ${note} | ${fmt(spent)} | ${fmt(total)} |`);

// Refresh the summary line above the table.
const summaryIndex = lines.findIndex((l) => l.startsWith('**Running total:'));
const summary =
  `**Running total: ${fmt(total)} tokens** across ${sessions} ` +
  `session${sessions === 1 ? '' : 's'}. Last updated ${date}.`;
if (summaryIndex !== -1) lines[summaryIndex] = summary;

writeFileSync(LOG, lines.join('\n'));
console.log(`Logged ${fmt(spent)} tokens. Running total: ${fmt(total)}.`);
