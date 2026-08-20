/*
 * qtmeta.mjs — read capture time out of a QuickTime / MP4 container.
 *
 * iPhone names its recordings IMG_1234.MOV, which carries no date at all, so
 * the filename tells us nothing. The real capture time lives in the file's
 * own metadata, and there are two places to look:
 *
 *   com.apple.quicktime.creationdate  "2026-07-14T21:25:57-0700"
 *       Local wall-clock time WITH the offset the phone was set to. This is
 *       the moment as the person experienced it, which is exactly what a
 *       noise record needs. Always prefer this.
 *
 *   moov/mvhd creation_time           seconds since 1904-01-01, in UTC
 *       A fallback. Survives some conversions, but re-encoding tools
 *       routinely rewrite it to the conversion time, so it is only trusted
 *       when nothing better exists and it is flagged when used.
 *
 * Files that have been converted or stripped often have neither, or carry an
 * mvhd date that is really the conversion date. Those are reported as
 * untrusted so the caller can discard them rather than plot a false date.
 */

const ATOM_HEADER = 8;
const QT_EPOCH_OFFSET = 2082844800; // seconds between 1904-01-01 and 1970-01-01

/* ---------- atom walking ---------- */

function readAtoms(buf, start = 0, end = buf.length) {
  const atoms = [];
  let offset = start;
  while (offset + ATOM_HEADER <= end) {
    let size = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    let headerSize = ATOM_HEADER;

    if (size === 1) {
      if (offset + 16 > end) break;
      size = Number(buf.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) break;

    atoms.push({ type, start: offset, end: offset + size, body: offset + headerSize });
    offset += size;
  }
  return atoms;
}

function findAtom(buf, type, start, end) {
  return readAtoms(buf, start, end).find((a) => a.type === type) || null;
}

/* ---------- the Apple keys/ilst pair ---------- */

/* `meta` is a full atom (4 version/flags bytes) in MP4 but a plain container
 * in QuickTime. Detect which by testing whether a sane atom starts at +0. */
function metaBody(buf, meta) {
  const direct = readAtoms(buf, meta.body, meta.end);
  if (direct.some((a) => a.type === 'keys' || a.type === 'ilst' || a.type === 'hdlr')) {
    return meta.body;
  }
  return meta.body + 4;
}

function readKeys(buf, keys) {
  const names = [];
  const count = buf.readUInt32BE(keys.body + 4);
  let offset = keys.body + 8;
  for (let i = 0; i < count && offset + 8 <= keys.end; i++) {
    const size = buf.readUInt32BE(offset);
    if (size < 8 || offset + size > keys.end) break;
    names.push(buf.toString('utf8', offset + 8, offset + size));
    offset += size;
  }
  return names; // index i here == ilst index i+1
}

function readIlst(buf, ilst, names) {
  const out = {};
  for (const item of readAtoms(buf, ilst.body, ilst.end)) {
    // The atom "type" of an ilst entry is its 1-based index into keys.
    const index = buf.readUInt32BE(item.start + 4);
    const name = names[index - 1];
    if (!name) continue;
    const data = findAtom(buf, 'data', item.body, item.end);
    if (!data) continue;
    const dataType = buf.readUInt32BE(data.body) & 0x00ffffff;
    const payload = buf.subarray(data.body + 8, data.end);
    // 1 = UTF-8. Everything else here (ints, floats) is not a date.
    out[name] = dataType === 1 ? payload.toString('utf8') : payload;
  }
  return out;
}

/* ---------- public API ---------- */

/**
 * Pull capture metadata out of a buffer holding the file's moov atom.
 */
export function parseMoov(buf) {
  const result = {
    creationDate: null, mvhdDate: null, location: null,
    make: null, model: null, software: null, durationSec: null,
  };

  const moovIndex = buf.indexOf('moov', 0, 'latin1');
  if (moovIndex < 4) return result;
  const moov = { body: moovIndex + 4, end: buf.length };

  const mvhd = findAtom(buf, 'mvhd', moov.body, moov.end);
  if (mvhd) {
    const version = buf[mvhd.body];
    let created, timescale, duration;
    if (version === 1) {
      created = Number(buf.readBigUInt64BE(mvhd.body + 4));
      timescale = buf.readUInt32BE(mvhd.body + 20);
      duration = Number(buf.readBigUInt64BE(mvhd.body + 24));
    } else {
      created = buf.readUInt32BE(mvhd.body + 4);
      timescale = buf.readUInt32BE(mvhd.body + 12);
      duration = buf.readUInt32BE(mvhd.body + 16);
    }
    if (created > QT_EPOCH_OFFSET) {
      result.mvhdDate = new Date((created - QT_EPOCH_OFFSET) * 1000);
    }
    if (timescale > 0) result.durationSec = duration / timescale;
  }

  const udta = findAtom(buf, 'udta', moov.body, moov.end);
  const meta = findAtom(buf, 'meta', moov.body, moov.end) ||
    (udta && findAtom(buf, 'meta', udta.body, udta.end));

  if (meta) {
    const body = metaBody(buf, meta);
    const keys = findAtom(buf, 'keys', body, meta.end);
    const ilst = findAtom(buf, 'ilst', body, meta.end);
    if (keys && ilst) {
      const tags = readIlst(buf, ilst, readKeys(buf, keys));
      const pick = (k) => (typeof tags[k] === 'string' ? tags[k] : null);
      result.creationDate = pick('com.apple.quicktime.creationdate');
      result.location = pick('com.apple.quicktime.location.ISO6709');
      result.make = pick('com.apple.quicktime.make');
      result.model = pick('com.apple.quicktime.model');
      result.software = pick('com.apple.quicktime.software');
    }
  }
  return result;
}

/**
 * Split an Apple creationdate into its literal wall-clock parts.
 * "2026-07-14T21:25:57-0700" -> wall clock 21:25:57 on 2026-07-14.
 * The offset is kept separately; the wall clock is what gets displayed.
 */
export function splitCreationDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})\s*([+-]\d{2}:?\d{2}|Z)?/
    .exec(String(value).trim());
  if (!m) return null;
  return {
    wallClock: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`,
    offset: m[7] || null,
  };
}
