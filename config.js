/*
 * HighCall After Dark — public site settings.
 * This file is public. Never put passwords, keys, or admin links here.
 */
window.CONTEST_CONFIG = {
  // Paste the Web app URL of the "After Dark — Submission API" Apps Script deployment
  // (it ends in /exec). See README.md, step 3.
  API_URL: "https://script.google.com/macros/s/AKfycbzE_VyrsmJN6mx8xiWPtiHBAMTNSgS3aCcTl2_vMrC2lEr3KfmcWUh3puM7MgyL-_PE4Q/exec",

  // Shown beside the upload field. The server enforces its own copy of these
  // limits in apps-script/backend/Config.gs — keep both in sync.
  ACCEPTED_EXTENSIONS: ["mp4", "mov"],
  ACCEPTED_LABEL: "MP4 or MOV",
  MAX_FILE_MB: 500,

  // Fallback dates, used only if the server can't be reached.
  // The server's own dates are always the ones enforced.
  OPENS_AT: "2026-11-11T00:00:00+08:00",
  CUTOFF_AT: "2026-11-26T00:00:00+08:00", // before 12:00 AM PHT, Nov 26 = 11:59 PM, Nov 25

  // Optional inspiration links. Leave the lists empty to hide the section.
  // Each item: { label: "What people will see", url: "https://..." }
  SAMPLE_VIDEOS: [
    // { label: "Sample transition video", url: "https://..." },
  ],
  MUSIC_IDEAS: [
    // { label: "Song or sound name", url: "https://..." },
  ],
};
