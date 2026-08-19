/*
 * config.js — all user-tunable settings.
 *
 * This site is intentionally a static, no-backend page: it reads a committed
 * JSON file of incidents and embeds each video straight from its Google Drive
 * share link. Nothing here needs a server, so it hosts fine on GitHub Pages.
 */
window.NCC_CONFIG = {
  /* ---------------------------------------------------------------
   * 1. WHERE THE DATA COMES FROM
   * ------------------------------------------------------------- */

  // The committed snapshot of your Drive folder. This is the normal path.
  // Regenerate it with either script in tools/ and commit the result:
  //   node tools/parse-drive-links.mjs links.txt     (zero setup)
  //   node tools/fetch-drive-metadata.mjs            (reads Drive directly)
  dataUrl: 'data/incidents.json',

  // OPTIONAL live mode. If you fill both of these in, the page queries the
  // Drive API on load instead of reading dataUrl, so new uploads appear
  // without regenerating anything. Leave blank for a public site — a key in
  // client-side code is readable by anyone who views source.
  driveFolderId: '',
  driveApiKey: '',

  /* ---------------------------------------------------------------
   * 2. WHAT COUNTS AS "AFTER HOURS"
   * ------------------------------------------------------------- */

  // Sherman Oaks is within the City of Los Angeles, so the LAMC applies.
  // Quiet hours are 10:00 PM - 7:00 AM (not 8 AM).
  //   LAMC 41.57  - loud and raucous noise prohibited
  //   LAMC 116.01 - loud, unnecessary and unusual noise
  //   LAMC 111.02 - presumed ambient 50 dBA (7a-10p) vs 40 dBA (10p-7a)
  // Hours are on a 24-hour clock; the window wraps past midnight.
  quietHours: {
    start: 22, // 10:00 PM
    end: 7,    //  7:00 AM
  },

  jurisdiction: {
    name: 'Sherman Oaks, City of Los Angeles',
    citation: 'LAMC §41.57, §116.01, §111.02',
    url: 'https://codelibrary.amlegal.com/codes/los_angeles/latest/lamc/0-0-0-129184',
  },

  /* ---------------------------------------------------------------
   * 3. HOW THE TIMESTAMP IS DECIDED
   * ------------------------------------------------------------- */

  // Order in which we try to establish when an incident actually happened.
  // "filename" is first on purpose: uploading a video to Drive resets its
  // Drive creation date to the upload time, which destroys the real capture
  // time. Phone and camera filenames almost always preserve it.
  timestampPriority: ['filename', 'media', 'driveCreated', 'driveModified'],

  /* ---------------------------------------------------------------
   * 4. HEATMAP TUNING
   * ------------------------------------------------------------- */

  // A day's heat score is its own incident count plus a share of its
  // neighbours', so clusters of consecutive nights read darker than isolated
  // one-offs. Index 0 = same day, 1 = +/-1 day, 2 = +/-2 days.
  clusterWeights: [1, 0.6, 0.25],

  // Score thresholds for the five shading levels. A day with no incidents of
  // its own is never shaded, no matter how loud its neighbours were.
  heatThresholds: [1.5, 2.5, 4, 6],

  // Time badges drawn in a calendar cell before the rest collapse to "+N".
  maxBadgesPerDay: 3,

  // 0 = weeks start Sunday, 1 = Monday.
  weekStartsOn: 0,
};
