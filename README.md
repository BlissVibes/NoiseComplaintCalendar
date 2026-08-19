# Noise Incident Log

A static website that turns a Google Drive folder of video recordings into a
calendar heat map of noise disturbances — using nothing but the timestamps on
the files.

The point is to make a repeated pattern impossible to miss: how often it
happens, how many nights in a row, and how much of it falls inside legal quiet
hours.

## What it does

- **Heat-mapped calendar** on the left, running yellow → orange → red →
  magenta → deep purple as incidents pile up. A day also escalates when its
  *neighbouring* days had incidents, so a run of four consecutive nights reads
  as one solid block rather than four separate dots.
- **Time badges on every date**, visible before you click. `11:47p` tells you
  when it happened. Multiple incidents get multiple badges.
- **After-hours badges glow red** and pulse. Those are incidents inside the
  Los Angeles quiet-hours window.
- **Click any date** to load that day's recordings in the right pane. Two
  videos, three videos, ten — each gets its own player, labelled
  "Recording 2 of 3", in chronological order.
- **Full incident list** below the player, grouped into collapsible months and
  sorted by date, with a **percentage of that month's days** that had an
  incident. There is an after-hours-only filter.
- **Full-year view** to see every month at once.
- **Export CSV** and **Print** (print styles switch to a light, paper-friendly
  layout) for attaching to a complaint.

## Quiet hours

Sherman Oaks is inside the City of Los Angeles, so the LA Municipal Code
applies. The quiet-hours window is **10:00 PM – 7:00 AM** — not 8 AM.

| Code | What it covers |
| --- | --- |
| LAMC §41.57 | Loud and raucous noise prohibited |
| LAMC §116.01 | Loud, unnecessary and unusual noise disturbing the peace |
| LAMC §111.02 | Presumed ambient: 50 dBA daytime (7a–10p), 40 dBA night (10p–7a) |

Noise more than 5 dBA above the presumed ambient is a violation, measured at
the receiving property line. Change the window in `js/config.js` if you ever
need to.

## Getting your videos in

The site reads one file: `data/incidents.json`. Until you create it, the page
falls back to bundled sample data so you can see how it looks.

### Option A — read the folder automatically (recommended)

One-time setup, about five minutes and free:

1. Open [console.cloud.google.com](https://console.cloud.google.com/) and
   create a project.
2. **APIs & Services → Library → Google Drive API → Enable.**
3. **APIs & Services → Credentials → Create credentials → API key.** Copy it.
4. In Google Drive, share your incidents folder as
   **Anyone with the link → Viewer**. This is also what lets the videos play
   on the published page.

Then, whenever you add recordings:

```bash
node tools/fetch-drive-metadata.mjs --folder <FOLDER_ID> --key <API_KEY>
git add data/incidents.json && git commit -m "Update incidents" && git push
```

`FOLDER_ID` is the tail of the folder URL:
`https://drive.google.com/drive/folders/1AbCdEf_GhIjK` → `1AbCdEf_GhIjK`

The script walks subfolders too, so a folder-per-month layout works fine.

**Your API key never reaches the published site** — it is only used locally by
this script. That matters, because anything in client-side JavaScript is
readable by everyone who visits.

### Option B — paste share links, no API key

Make a text file with one recording per line, filename and share link
separated by a tab or comma:

```
PXL_20250523_225601123.mp4	https://drive.google.com/file/d/1AbC.../view
PXL_20250524_231902441.mp4	https://drive.google.com/file/d/1XyZ.../view
```

```bash
node tools/parse-drive-links.mjs links.txt
```

The filename matters — that is where the capture time comes from.

### Option C — live mode

Fill in `driveFolderId` and `driveApiKey` in `js/config.js` and the page
queries Drive on every load, so new uploads appear with no regeneration. Only
do this for a private/local copy; on a public URL the key is exposed.

## How the timestamp is decided

This is the part that determines whether the calendar is true, so it is worth
understanding.

**Uploading a video to Google Drive sets that file's Drive "created" date to
the upload time, not the time you shot it.** If you record five nights of
disturbances and upload them all on Sunday, Drive reports five incidents on
Sunday, and the calendar would be worthless.

So sources are tried in this order (configurable in `js/config.js`):

| Priority | Source | Confidence |
| --- | --- | --- |
| 1 | Capture time parsed from the **filename** | High |
| 2 | Embedded **EXIF** metadata (images) | High |
| 3 | Drive **upload** date | Low — flagged with a warning in the UI |
| 4 | Drive **modified** date | Low — flagged with a warning in the UI |

Recognised filename formats include `PXL_20250523_225601123.mp4` (Pixel),
`VID_20250523_225601.mp4`, `20250523_225601.mp4`,
`2025-05-23 22.56.01.mov` (iPhone/QuickTime),
`Screen Recording 2025-05-23 at 10.56.01 PM.mov`, and Ring/Nest-style names.

**Do not rename your files.** The original camera filename is the evidence.

Anything falling back to a Drive date is labelled "Drive upload date" on the
incident card with an amber warning, so you are never presenting an upload
time as if it were an incident time.

### Time zones

Incident times are **shown exactly as recorded**, in the record's own zone, and
do not shift based on where the page is opened from. A recording stamped
10:56 PM reads 10:56 PM whether the viewer is in Sherman Oaks or Tokyo. This
matters because a landlord, HOA, or city office may open the link from
anywhere, and a time that drifts turns a 10:56 PM violation into a lawful
2:56 PM afternoon on the wrong date.

Filename and EXIF timestamps carry no zone at all — they are the literal digits
the camera wrote — so they are used verbatim. The only values that need a zone
are Drive's upload/modified dates, which are absolute UTC instants; those are
converted once into `recordTimeZone` in `js/config.js` (default
`America/Los_Angeles`) and pinned there. Daylight saving is handled, so a
January incident resolves against PST and a June one against PDT.

Every incident card shows its raw reading verbatim — `RECORDED 2025-07-12
22:08:20`, alongside the exact text it was scraped from
(`read from "20250712_220820"`) — so the displayed time can be checked against
the file itself rather than taken on trust. That value is also a column in the
CSV export. The zone in use is stated in the page footer.

To correct a single entry by hand, add `timestampOverride` to it in
`data/incidents.json`:

```json
{ "id": "1AbC...", "name": "clip.mp4", "timestampOverride": "2025-05-23T22:56:00" }
```

Write the override without a `Z` or offset and it is taken as a literal
wall-clock reading. Add one (`...22:56:00Z`) and it is treated as an absolute
instant and converted into `recordTimeZone`.

You can also add a `"note"` to any entry and it will show on the card.

## Publishing

Settings → Pages → Deploy from branch → `main` → `/ (root)`. It is a plain
static site, no build step.

## Tuning

Everything adjustable lives in `js/config.js`: the quiet-hours window, the
heat-map cluster weights and thresholds, how many time badges fit in a cell,
and whether weeks start on Sunday or Monday.

## Later: the multi-user version

Data enters the app through exactly one function — `NCCData.load()` in
`js/data.js`. Everything downstream consumes the array it returns. Turning
this into an account-based service with a backend and per-account public URLs
means replacing that one function with an API call; the calendar, heat map,
badges, and list code do not change.

## Layout

```
index.html                       page shell
css/styles.css                   all styling, incl. print stylesheet
js/config.js                     every tunable setting
js/timestamps.js                 filename/EXIF capture-time extraction
js/incidents.js                  incident model, quiet hours, heat scoring
js/data.js                       the single data-loading seam
js/ui.js                         rendering
js/app.js                        state and event wiring
tools/fetch-drive-metadata.mjs   Drive folder  -> data/incidents.json
tools/parse-drive-links.mjs      pasted links  -> data/incidents.json
data/sample-incidents.json       demo data
TOKENS.md                        running tally of AI tokens spent building this
v2_plan.md                       everything deferred to the multi-user version
```

## Note

This page is a factual record of file timestamps. It is not legal advice.
Times display exactly as recorded, in the record's own time zone.
