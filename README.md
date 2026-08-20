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

### Option A — scan the folder (recommended, no API key)

```bash
node tools/scan-drive-folder.mjs
git add data/incidents.json && git commit -m "Update incidents" && git push
```

That is the whole thing. No Google Cloud project, no API key, no setup — it
works on any folder shared as **Anyone with the link → Viewer**.

It reads each recording's **own capture time** out of the video file, because
the filename usually cannot be trusted: an iPhone names its clips
`IMG_0477.MOV`, which contains no date at all. The real time is stored inside
the file as `com.apple.quicktime.creationdate`, in local wall-clock time with
the offset the phone was set to — the moment as you experienced it.

It only reads the few megabytes holding that metadata, using HTTP range
requests, so a 640 MB recording costs about a 3 MB download.

**Anything without a trustworthy capture time is discarded, not guessed at.**
A converted or re-encoded clip normally has its metadata stripped, and its
only remaining date is when it was uploaded. Plotting that would put a false
incident on the calendar, which is worse than leaving it out. Discards are
listed when the scan finishes and recorded in the `discarded` field of
`data/incidents.json`.

If a file is discarded but you still have the original, re-upload it without
converting and the capture time comes back. Otherwise add a `captureTime` by
hand:

```json
{ "id": "1AbC…", "name": "IMG_0825.MOV", "captureTime": "2026-08-19 03:20:23" }
```

### Option B — the Drive API (only if you need Drive's own fields)

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

### Keeping it up to date as you add recordings

Two ways, both driven by you rather than running on their own.

**The "Check Drive" button on the page.** Click it, paste your API key once,
and it scans the folder and lists everything not already on the calendar,
showing the date it would read from each file so a bad filename is obvious
before it goes anywhere. Then either:

- *Show on calendar now* — merges them into the current view immediately.
  This is temporary and only in your browser; a reload returns to the
  committed data.
- *Download incidents.json* — save it over `data/incidents.json` and commit.
  That is what makes it permanent for everyone.

The key is stored in your browser's localStorage, never in the page source, so
visitors to the public URL cannot see or use it, and the panel does nothing for
them. "Forget saved key" clears it.

**The GitHub Action**, which needs no key in any browser. Add your key once at
Settings → Secrets and variables → Actions as `DRIVE_API_KEY`, then hit
Actions → "Update incidents from Drive" → Run workflow. It regenerates and
commits `data/incidents.json` for you. It also runs weekly on Mondays; delete
the `schedule:` block in `.github/workflows/update-incidents.yml` if you would
rather it only ever run when you press the button.

### Option C — paste share links

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
| 1 | **Camera metadata** inside the file (`com.apple.quicktime.creationdate`) | High |
| 2 | Capture time parsed from the **filename** | High |
| 3 | Embedded **EXIF** metadata (images) | High |
| 4 | Drive **upload** date | Low — flagged with a warning in the UI |
| 5 | Drive **modified** date | Low — flagged with a warning in the UI |

Recognised filename formats include `PXL_20250523_225601123.mp4` (Pixel),
`VID_20250523_225601.mp4`, `20250523_225601.mp4`,
`2025-05-23 22.56.01.mov` (iPhone/QuickTime),
`Screen Recording 2025-05-23 at 10.56.01 PM.mov`, and Ring/Nest-style names.

**Do not convert or re-encode your recordings.** Renaming is survivable now
that the capture time is read from inside the file, but converting strips that
metadata and the real time is gone for good.

The in-page "Check Drive" button will tell you when new files exist, but it
will refuse to add them to the calendar when their dates cannot be trusted —
a browser cannot read inside the video files, so it would only have the upload
date to offer. It points you at the scanner instead.

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
tools/scan-drive-folder.mjs      Drive folder  -> data/incidents.json (no key)
tools/lib/qtmeta.mjs             QuickTime/MP4 capture-time reader
tools/fetch-drive-metadata.mjs   Drive API variant (needs a key)
tools/parse-drive-links.mjs      pasted links  -> data/incidents.json
js/sync.js                       the in-page "Check Drive" scanner
.github/workflows/               scheduled + manual Drive refresh
data/sample-incidents.json       demo data
TOKENS.md                        running tally of AI tokens spent building this
v2_plan.md                       everything deferred to the multi-user version
```

## Note

This page is a factual record of file timestamps. It is not legal advice.
Times display exactly as recorded, in the record's own time zone.
