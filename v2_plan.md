# v2 Plan

Everything discussed but deliberately **not** built in v1, plus the notes and
constraints worth not rediscovering later.

v1 is a static, single-tenant page: a committed JSON file, a calendar, and
Drive embeds. That is all it is meant to be. This document is where the larger
idea lives until it is worth building.

---

## The v1 → v2 seam

The one thing v1 does structurally to make v2 cheap:

**All incident data enters through a single function — `NCCData.load()` in
`js/data.js`.** Everything downstream (heat scoring, calendar, badges, month
list, CSV export) consumes the array it returns and knows nothing about where
it came from. Replacing that function with an authenticated API call is the
whole data-layer migration. The calendar, heat map, badges, and list code do
not change.

The incident shape that contract produces is defined in
`NCCIncidents.build()`. Keep it stable, or version it.

---

## 1. Accounts and a backend

**Goal:** a user signs up, submits incidents as they happen, and gets a public
URL for their own record.

- Auth, per-user storage, per-user Drive (or direct upload) connection.
- Public share URL per account, e.g. `/r/<slug>`, with the slug user-chosen.
- Per-account visibility: public, unlisted, private, or link-only.
- The static build stays the fallback and the export format.

**Open question worth settling early:** does the service store the videos, or
keep pointing at the user's own Drive? Storing them means transcoding, storage
cost, and takedown handling. Pointing at Drive means playback breaks whenever
the owner changes sharing settings — which is exactly the failure mode v1
already has.

## 2. Editable title and record metadata

v1 has `siteTitle` and `siteEyebrow` in `js/config.js`, currently set to
"4632 Natick Park South — Noise Complaints against Apt 201".

v2 makes these editable in the page, per account, saved to the backend:

- Title, subtitle, and an optional description paragraph.
- Property address, unit under complaint, complainant contact.
- Jurisdiction picker that sets the quiet-hours window automatically rather
  than requiring a config edit (see §6).

## 3. Submitting incidents as they happen

The "record it now" flow, which v1 has no equivalent of:

- Upload from phone directly, or a watched Drive folder that syncs.
- Capture the real timestamp at upload time, before any metadata is lost —
  this removes v1's whole reliance on filename parsing.
- Optional fields at submission: a note, a decibel reading, a category
  (music / bass / shouting / stomping / power tools / vehicle), and whether
  police or management were contacted.
- Optional: a live decibel meter in the browser via `getUserMedia`, storing
  dB(A) alongside the clip. This is what turns the record from "it was loud"
  into "it was 62 dBA at the property line at 11:40 PM", which is the actual
  LAMC §111.02 standard. Big credibility gain; needs calibration caveats.

## 4. Deferred UI work

Noted during v1 and consciously skipped:

- **Manual timestamp correction in the UI.** v1 supports a
  `timestampOverride` field in `data/incidents.json` but there is no interface
  for it — you edit JSON by hand.
- **Per-incident notes in the UI.** Same: the `note` field renders on the
  card, but can only be set by editing the data file.
- **Filter by time of day** (e.g. "only show 11 PM – 2 AM").
- **Filter by date range**, and a "last 30 / 90 days" quick view.
- **Tags / categories** and filtering by them.
- **A complaint packet export** — a formatted PDF with the calendar, the
  statistics, and a dated incident table, ready to attach to a letter to a
  landlord, HOA, or the city. v1 has CSV plus a print stylesheet; this would
  be the real deliverable.
- **Weekday/hour distribution chart** ("it is always Friday and Saturday
  between 11 PM and 1 AM"), which is often the most persuasive single view.
- **Streak highlighting on the calendar** — outlining consecutive runs rather
  than only shading them.

## 5. Time zones — resolved in v1

Originally logged here as the highest-risk correctness gap; fixed rather than
deferred, and recorded for context.

Incident times are wall-clock readings shown exactly as recorded, never
re-interpreted for the viewer. Filename and EXIF timestamps carry no zone and
are used verbatim. Drive's `createdTime`/`modifiedTime` are absolute UTC
instants, so they are converted once into `config.recordTimeZone` (default
`America/Los_Angeles`) and pinned there, with DST handled via `Intl`.

Verified identical across America/Los_Angeles, America/New_York, UTC,
Asia/Tokyo, and Australia/Sydney.

**What v2 still needs:** `recordTimeZone` is one global config value. Per-record
storage of an IANA zone is required once there are multiple accounts, and the
jurisdiction picker (§6) should set it alongside the quiet-hours window. A
record whose incidents genuinely span zones (someone who moved mid-record)
would need per-incident zones, which is not worth building until it appears.

## 6. Jurisdictions

v1 hard-codes Los Angeles quiet hours (10:00 PM – 7:00 AM) with the citation
in `js/config.js`.

v2 wants a small table of jurisdictions — hours, citation, link, and any
decibel limits — selected per record. Most US cities use 10 PM or 11 PM to
7 AM, but the citation text and the decibel standard vary, and the citation is
the part that makes a complaint land.

Note that LA distinguishes general noise (§41.57, §116.01) from construction
(§112.05, which bars work 9 PM – 7 AM weekdays, before 8 AM Saturday, and all
day Sunday). A category field (§3) would let the right rule apply per
incident.

## 7. Privacy and abuse

A public, multi-tenant version of this is a system for publishing accusations
about identifiable addresses and units. That is fine for the person keeping
their own record and a real problem at scale. Before opening signups:

- Decide whether unit numbers and addresses may appear on public pages, or
  whether public view is coarsened (block-level, or initials).
- A takedown and dispute path for the accused party.
- Rate limiting and a check against the same address being targeted by many
  accounts.
- Clear framing that these are timestamps of recordings, not adjudicated
  findings.

None of this blocks v1, which is one person documenting their own situation.
All of it blocks a public launch.

## 8. Smaller things noted in passing

- **API key exposure.** v1's optional live-Drive mode puts a Drive API key in
  client-side JavaScript, which is readable by anyone. The README says to use
  it only for local/private copies. v2's backend removes the problem entirely.
- **Playback depends on Drive sharing.** If the folder stops being
  link-shared, every embed goes blank with no warning on the page. A health
  check that flags unreachable files would be worth having.
- **Capture time now comes from inside the file.** `tools/lib/qtmeta.mjs`
  parses QuickTime/MP4 atoms for `com.apple.quicktime.creationdate`, which is
  what makes iPhone recordings usable at all — `IMG_0477.MOV` has no date in
  its name. v2's upload flow should read this at submission time and store it,
  so the parsing only ever happens once. The same metadata also carries GPS
  (`com.apple.quicktime.location.ISO6709`) and device model, which could
  corroborate that recordings were made at the complainant's address.
- **Converted files lose everything.** Re-encoding strips the capture time and
  leaves only an mvhd date that the converter overwrote. v1 discards these. A
  v2 upload flow should warn at upload time, while the user still has the
  original.
- **Filename formats.** `js/timestamps.js` handles Pixel, Android, iPhone,
  QuickTime, and Ring-style names. Anything unrecognised falls back to the
  Drive upload date and is flagged low-confidence in the UI. New camera
  formats mean new patterns; keep the test list in that file current.
- **Heat scoring is tunable, not learned.** `clusterWeights` and
  `heatThresholds` in `js/config.js` are hand-picked. With real data across
  many accounts, thresholds could adapt per record so the scale always uses
  its full range.
- **Six stat cards** can read oddly on sparse data (several showing the same
  small number). Consider collapsing to four with real-data testing.
- **Token log.** `TOKENS.md` tracks AI tokens spent building this, appended
  via `tools/log-tokens.mjs`. Keep it going; it is a running joke with a real
  number attached.
