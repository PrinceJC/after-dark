/* HighCall After Dark — submission page logic */
(function () {
  "use strict";

  var CFG = window.CONTEST_CONFIG || {};
  var CHUNK = 8 * 1024 * 1024; // 8 MiB (must be a multiple of 256 KiB)
  var MAX_RETRIES = 6;
  var TZ = "Asia/Manila";

  var $ = function (id) { return document.getElementById(id); };
  var form = $("entry-form");
  var submitBtn = $("submit-btn");
  var dropzone = $("dropzone");
  var fileInput = $("video");

  var limits = {
    extensions: (CFG.ACCEPTED_EXTENSIONS || ["mp4", "mov"]).map(function (e) { return String(e).toLowerCase(); }),
    maxBytes: (CFG.MAX_FILE_MB || 500) * 1024 * 1024,
    label: CFG.ACCEPTED_LABEL || "MP4 or MOV",
  };

  var period = {
    opensAt: new Date(CFG.OPENS_AT || "2026-11-11T00:00:00+08:00"),
    cutoffAt: new Date(CFG.CUTOFF_AT || "2026-11-26T00:00:00+08:00"),
    graceMinutes: 60,
    serverOffsetMs: 0,
    serverKnown: false,
  };

  var state = { file: null, attempt: null, busy: false, done: false };
  var apiConfigured = /^https:\/\/script\.google(usercontent)?\.com\//.test(CFG.API_URL || "");

  /* ---------------- helpers ---------------- */
  function fmtBytes(n) {
    if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
    return Math.max(1, Math.round(n / 1024)) + " KB";
  }
  function fmtPHT(d, withSeconds) {
    var opts = { timeZone: TZ, month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" };
    if (withSeconds) opts.second = "2-digit";
    return new Intl.DateTimeFormat("en-US", opts).format(d) + " PHT";
  }
  function fmtTimePHT(d) {
    return new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(d) + " PHT";
  }
  function now() { return new Date(Date.now() + period.serverOffsetMs); }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var a = new Uint8Array(16); crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }
  function ext(name) { var m = /\.([a-z0-9]+)$/i.exec(name || ""); return m ? m[1].toLowerCase() : ""; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function fileSig(f) { return [f.name, f.size, f.lastModified].join("|"); }

  function UploadError(code, message) { this.code = code; this.message = message; }

  /* ---------------- period / status ---------------- */
  function phase() {
    var t = now();
    if (t < period.opensAt) return "before";
    if (t >= period.cutoffAt) return "closed";
    return "open";
  }

  function timeLeft() {
    var ms = period.cutoffAt - now();
    var d = Math.floor(ms / 86400000), h = Math.floor(ms / 3600000) % 24, m = Math.floor(ms / 60000) % 60;
    if (d > 0) return d + (d === 1 ? " day " : " days ") + h + (h === 1 ? " hour" : " hours") + " left";
    if (h > 0) return h + (h === 1 ? " hour " : " hours ") + m + " min left";
    return Math.max(m, 0) + " min left";
  }

  function renderPhase() {
    var p = phase();
    var bar = $("status-bar"), text = $("status-text"), cta = $("status-cta");
    bar.dataset.phase = p;

    if (!apiConfigured) {
      text.textContent = "The submission page isn’t connected yet. Please check back soon.";
      cta.hidden = true;
      submitBtn.disabled = true;
      return;
    }

    if (p === "open") {
      text.textContent = "Submissions are open until November 25, 11:59 PM PHT. " + timeLeft() + ".";
      cta.hidden = state.done;
      $("closed-msg").hidden = true;
      if (!state.done) form.hidden = false;
    } else {
      cta.hidden = true;
      if (p === "before") {
        text.textContent = "Submissions open on " + fmtPHT(period.opensAt) + ".";
        $("closed-title").textContent = "Submissions aren’t open yet";
        $("closed-body").textContent = "The submission period starts on " + fmtPHT(period.opensAt) +
          " and runs until November 25, 2026, 11:59 PM PHT. Come back then to upload your video.";
      } else {
        text.textContent = "Submissions closed on November 25, 2026, 11:59 PM PHT.";
        $("closed-title").textContent = "Submissions are closed";
        $("closed-body").textContent = "The submission period ended on November 25, 2026, at 11:59 PM PHT, and late entries can’t be accepted. " +
          "Winners are announced on November 27, 2026, during the event. People’s Choice reactions are counted on HighCall VA’s official TikTok and Facebook posts until November 30, 2026, 11:59 PM PHT.";
      }
      // Never yank the form away from someone mid-upload — the server decides.
      if (!state.busy && !state.done) {
        form.hidden = true;
        $("closed-msg").hidden = false;
      }
    }
  }

  function renderGraceNote() {
    var g = period.graceMinutes;
    var t = $("grace-text");
    if (g > 0) {
      var until = new Date(period.cutoffAt.getTime() + g * 60000);
      t.textContent = "If you select Submit entry before 12:00 AM PHT on November 26, your entry is registered on time and your video may keep uploading until " +
        fmtTimePHT(until) + ". Uploads that haven’t finished by then are not accepted. Start early so a slow connection doesn’t cost you your spot.";
    } else {
      t.textContent = "Your video must finish uploading before 12:00 AM PHT on November 26. An upload still in progress at midnight is not accepted, so start early.";
    }
  }

  function loadStatus() {
    if (!apiConfigured) { renderPhase(); return; }
    var t0 = Date.now();
    fetch(CFG.API_URL + "?action=status", { method: "GET" })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (!s || !s.ok) return;
        var rtt = Date.now() - t0;
        period.serverOffsetMs = new Date(s.now).getTime() + rtt / 2 - Date.now();
        period.opensAt = new Date(s.opensAt);
        period.cutoffAt = new Date(s.cutoffAt);
        period.graceMinutes = Number(s.graceMinutes) || 0;
        if (s.maxBytes) limits.maxBytes = s.maxBytes;
        if (s.extensions && s.extensions.length) limits.extensions = s.extensions;
        if (s.acceptedLabel) limits.label = s.acceptedLabel;
        period.serverKnown = true;
        renderLimits();
        renderGraceNote();
        renderPhase();
      })
      .catch(function () { /* fall back to local dates */ renderPhase(); });
  }

  function renderLimits() {
    $("lim-formats").textContent = limits.label;
    $("lim-size").textContent = fmtBytes(limits.maxBytes).replace(".0 ", " ");
    fileInput.setAttribute("accept", limits.extensions.map(function (e) { return "." + e; }).join(",") + ",video/mp4,video/quicktime");
  }

  /* ---------------- inspiration links ---------------- */
  function renderLinks(list, ul, block) {
    var items = (list || []).filter(function (x) { return x && /^https?:\/\//i.test(x.url || ""); });
    if (!items.length) return false;
    items.forEach(function (x) {
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = x.url; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.textContent = x.label || x.url;
      li.appendChild(a); ul.appendChild(li);
    });
    block.hidden = false;
    return true;
  }
  var hasSamples = renderLinks(CFG.SAMPLE_VIDEOS, $("samples-list"), $("samples-block"));
  var hasMusic = renderLinks(CFG.MUSIC_IDEAS, $("music-list"), $("music-block"));
  if (hasSamples || hasMusic) $("inspiration").hidden = false;

  /* ---------------- draft persistence (text fields only) ---------------- */
  var DRAFT_KEY = "hcad-draft";
  var textIds = ["fullName", "email", "entryTitle", "character", "description"];
  try {
    var draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "{}");
    textIds.forEach(function (id) { if (draft[id]) $(id).value = draft[id]; });
  } catch (e) { /* storage unavailable */ }
  function saveDraft() {
    try {
      var d = {}; textIds.forEach(function (id) { d[id] = $(id).value; });
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    } catch (e) { /* ignore */ }
  }
  form.addEventListener("input", saveDraft);

  var desc = $("description");
  function updateCount() { $("desc-count").textContent = desc.value.length.toLocaleString(); }
  desc.addEventListener("input", updateCount); updateCount();

  /* ---------------- file selection ---------------- */
  function validateFile(f) {
    if (!f) return "Choose your video file to upload.";
    if (limits.extensions.indexOf(ext(f.name)) === -1) {
      return "“" + f.name + "” isn’t a supported format. Upload your video as " + limits.label + ".";
    }
    if (f.size === 0) return "This file is empty. Choose the finished video file.";
    if (f.size > limits.maxBytes) {
      return "This file is " + fmtBytes(f.size) + ", which is over the " + fmtBytes(limits.maxBytes).replace(".0 ", " ") +
        " limit. Try exporting it again at 1080p, or with a lower quality setting.";
    }
    return "";
  }

  function setFile(f) {
    if (state.busy) return;
    var err = validateFile(f);
    if (err) {
      showFieldError("video", err);
      dropzone.classList.add("is-invalid");
      return;
    }
    clearFieldError("video");
    dropzone.classList.remove("is-invalid");
    if (!state.file || fileSig(state.file) !== fileSig(f)) state.attempt = null; // new file → new attempt
    state.file = f;
    $("dz-filename").textContent = f.name;
    $("dz-filesize").textContent = fmtBytes(f.size);
    $("dz-empty").hidden = true;
    $("dz-file").hidden = false;
    dropzone.classList.add("has-file");
    hideAlert();
  }

  function clearFile() {
    if (state.busy) return;
    state.file = null; state.attempt = null;
    fileInput.value = "";
    $("dz-empty").hidden = false;
    $("dz-file").hidden = true;
    dropzone.classList.remove("has-file", "is-invalid");
  }

  fileInput.addEventListener("change", function () {
    if (fileInput.files && fileInput.files[0]) setFile(fileInput.files[0]);
    fileInput.value = ""; // allow choosing the same file again later
  });
  $("remove-btn").addEventListener("click", function () { clearFile(); fileInput.focus(); });

  ["dragenter", "dragover"].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      if (!state.busy) dropzone.classList.add("is-dragover");
    });
  });
  ["dragleave", "dragend"].forEach(function (ev) {
    dropzone.addEventListener(ev, function () { dropzone.classList.remove("is-dragover"); });
  });
  dropzone.addEventListener("drop", function (e) {
    e.preventDefault();
    dropzone.classList.remove("is-dragover");
    var files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    if (files.length > 1) { showFieldError("video", "Drop one video at a time."); return; }
    setFile(files[0]);
  });
  // Stop the browser from opening a file dropped outside the drop area.
  window.addEventListener("dragover", function (e) { e.preventDefault(); });
  window.addEventListener("drop", function (e) { e.preventDefault(); });

  /* ---------------- validation ---------------- */
  function showFieldError(id, msg) {
    var errEl = $(id + "-err");
    if (errEl) errEl.textContent = msg;
    var input = $(id);
    if (input && input.tagName !== "FIELDSET") input.setAttribute("aria-invalid", "true");
  }
  function clearFieldError(id) {
    var errEl = $(id + "-err");
    if (errEl) errEl.textContent = "";
    var input = $(id);
    if (input) input.removeAttribute("aria-invalid");
  }

  function collectFields() {
    return {
      fullName: $("fullName").value.trim(),
      email: $("email").value.trim(),
      entryTitle: $("entryTitle").value.trim(),
      character: $("character").value.trim(),
      description: $("description").value.trim(),
      website: $("website").value, // honeypot
      agreeRules: $("agreeRules").checked,
      agreeConfidential: $("agreeConfidential").checked,
      agreePublish: $("agreePublish").checked,
    };
  }

  function validate(fields) {
    var errors = {};
    if (!fields.fullName) errors.fullName = "Enter your full name.";
    if (!fields.email) errors.email = "Enter your email address.";
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(fields.email)) errors.email = "Enter a valid email address, like name@example.com.";
    if (!fields.entryTitle) errors.entryTitle = "Give your entry a title.";
    if (!fields.character) errors.character = "Tell us which character you portray.";
    var fe = validateFile(state.file);
    if (fe) errors.video = fe;
    if (!fields.agreeRules || !fields.agreeConfidential || !fields.agreePublish) errors.confirms = "Tick all three boxes to submit your entry.";
    return errors;
  }

  function applyErrors(errors) {
    ["fullName", "email", "entryTitle", "character", "video", "confirms"].forEach(clearFieldError);
    dropzone.classList.toggle("is-invalid", !!errors.video);
    var first = null;
    Object.keys(errors).forEach(function (k) {
      showFieldError(k, errors[k]);
      if (!first) first = k;
    });
    if (first) {
      var focusEl = first === "video" ? fileInput : first === "confirms" ? $("agreeRules") : $(first);
      (first === "video" ? dropzone : focusEl).scrollIntoView({ block: "center", behavior: "smooth" });
      focusEl.focus({ preventScroll: true });
    }
    return !first;
  }

  ["fullName", "email", "entryTitle", "character"].forEach(function (id) {
    $(id).addEventListener("input", function () { clearFieldError(id); });
  });
  ["agreeRules", "agreeConfidential", "agreePublish"].forEach(function (id) {
    $(id).addEventListener("change", function () { clearFieldError("confirms"); });
  });

  /* ---------------- UI state ---------------- */
  function lock(on) {
    state.busy = on;
    submitBtn.disabled = on;
    submitBtn.textContent = on ? "Submitting…" : "Submit entry";
    Array.prototype.forEach.call(form.querySelectorAll("input, textarea"), function (el) {
      if (el.id !== "website") el.disabled = on;
    });
    $("remove-btn").disabled = on;
    $("replace-btn").setAttribute("aria-disabled", on ? "true" : "false");
    $("replace-btn").style.pointerEvents = on ? "none" : "";
    dropzone.classList.toggle("is-locked", on);
  }

  function showAlert(html, retry) {
    var box = $("form-alert");
    box.innerHTML = "";
    var p = document.createElement("p");
    p.innerHTML = html;
    box.appendChild(p);
    if (retry) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "retry-btn"; b.textContent = "Try again";
      b.addEventListener("click", function () { form.requestSubmit ? form.requestSubmit() : submitBtn.click(); });
      box.appendChild(b);
    }
    box.hidden = false;
    box.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  function hideAlert() { $("form-alert").hidden = true; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  var speed = { t: 0, bytes: 0, rate: 0 };
  function setProgress(label, uploaded, total) {
    $("progress-box").hidden = false;
    $("progress-label").textContent = label;
    var pct = total ? Math.floor((uploaded / total) * 100) : 0;
    $("progress-pct").textContent = pct + "%";
    $("progress-fill").style.width = pct + "%";
    $("progress-bar").setAttribute("aria-valuenow", String(pct));
    var t = Date.now();
    if (speed.t && t - speed.t > 800) {
      var inst = (uploaded - speed.bytes) / ((t - speed.t) / 1000);
      speed.rate = speed.rate ? speed.rate * 0.7 + inst * 0.3 : inst;
      speed.t = t; speed.bytes = uploaded;
    } else if (!speed.t) { speed.t = t; speed.bytes = uploaded; }
    var detail = fmtBytes(uploaded) + " of " + fmtBytes(total);
    if (speed.rate > 0 && uploaded < total) {
      var secs = Math.round((total - uploaded) / speed.rate);
      detail += ", about " + (secs >= 90 ? Math.round(secs / 60) + " min" : secs + " sec") + " remaining";
    }
    $("progress-detail").textContent = detail;
  }
  function setStage(label) {
    $("progress-box").hidden = false;
    $("progress-label").textContent = label;
  }

  /* ---------------- API ---------------- */
  function api(action, payload) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 60000) : null;
    var body = Object.assign({ action: action }, payload);
    return fetch(CFG.API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // simple request: no CORS preflight
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined,
    }).then(function (r) {
      if (timer) clearTimeout(timer);
      return r.json().catch(function () { throw new UploadError("SERVER", ""); });
    }, function () {
      if (timer) clearTimeout(timer);
      throw new UploadError("NETWORK", "");
    }).then(function (res) {
      if (!res || !res.ok) {
        var e = new UploadError((res && res.code) || "SERVER", (res && res.message) || "");
        e.fieldErrors = res && res.fieldErrors;
        e.retryable = res && res.retryable;
        throw e;
      }
      return res;
    });
  }

  /* ---------------- resumable upload straight to Google Drive ---------------- */
  function xhrPut(url, headers, body, onProgress) {
    return new Promise(function (resolve) {
      var x = new XMLHttpRequest();
      x.open("PUT", url, true);
      Object.keys(headers).forEach(function (h) { x.setRequestHeader(h, headers[h]); });
      if (onProgress && x.upload) x.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded); };
      x.onload = function () { resolve({ status: x.status, range: x.getResponseHeader("Range"), text: x.responseText }); };
      x.onerror = function () { resolve({ status: 0 }); };
      x.ontimeout = function () { resolve({ status: 0 }); };
      x.timeout = 10 * 60 * 1000;
      x.send(body);
    });
  }

  function nextOffsetFrom(rangeHeader) {
    var m = /bytes=0-(\d+)/.exec(rangeHeader || "");
    return m ? parseInt(m[1], 10) + 1 : 0;
  }

  function parseFileId(text) {
    try { var j = JSON.parse(text); return j && j.id; } catch (e) { return null; }
  }

  function queryOffset(url, total) {
    return xhrPut(url, { "Content-Range": "bytes */" + total }, null).then(function (r) {
      if (r.status === 200 || r.status === 201) return { done: true, fileId: parseFileId(r.text) };
      if (r.status === 308) return { done: false, offset: nextOffsetFrom(r.range) };
      if (r.status === 404 || r.status === 410) throw new UploadError("SESSION_EXPIRED", "");
      throw new UploadError(r.status === 0 ? "NETWORK" : "UPLOAD", "");
    });
  }

  async function uploadFile(file, attempt) {
    var total = file.size;
    var offset = 0;
    var failures = 0;
    speed = { t: 0, bytes: 0, rate: 0 };

    if (attempt.resume) {
      // Ask Google how much it already has — resume instead of restarting.
      var q = await queryOffset(attempt.uploadUrl, total);
      if (q.done) return q.fileId;
      offset = q.offset;
    }
    attempt.resume = true;

    while (offset < total) {
      var end = Math.min(offset + CHUNK, total);
      var base = offset;
      setProgress("Uploading your video…", base, total);
      var r = await xhrPut(
        attempt.uploadUrl,
        { "Content-Range": "bytes " + offset + "-" + (end - 1) + "/" + total },
        file.slice(offset, end),
        function (loaded) { setProgress("Uploading your video…", base + loaded, total); }
      );

      if (r.status === 200 || r.status === 201) {
        setProgress("Upload complete", total, total);
        var id = parseFileId(r.text);
        if (!id) throw new UploadError("UPLOAD", "");
        return id;
      }
      if (r.status === 308) { offset = r.range ? nextOffsetFrom(r.range) : end; failures = 0; continue; }
      if (r.status === 404 || r.status === 410) throw new UploadError("SESSION_EXPIRED", "");
      if (r.status === 0 || r.status === 408 || r.status === 429 || r.status >= 500) {
        failures++;
        if (failures > MAX_RETRIES) throw new UploadError("NETWORK", "");
        var wait = Math.min(30000, 1000 * Math.pow(2, failures - 1));
        setStage("Connection interrupted — retrying in " + Math.round(wait / 1000) + " s…");
        await sleep(wait);
        try {
          var s = await queryOffset(attempt.uploadUrl, total);
          if (s.done) return s.fileId;
          offset = s.offset;
        } catch (e) { if (e.code === "SESSION_EXPIRED") throw e; /* else loop and retry */ }
        continue;
      }
      throw new UploadError("UPLOAD", "");
    }
    // All bytes sent but no final response: ask once more.
    var fin = await queryOffset(attempt.uploadUrl, total);
    if (fin.done && fin.fileId) return fin.fileId;
    throw new UploadError("UPLOAD", "");
  }

  /* ---------------- submit flow ---------------- */
  var MESSAGES = {
    NETWORK: "<strong>Your connection dropped.</strong> Your details and file are still here. Check your internet, then select Try again — the upload continues from where it stopped.",
    UPLOAD: "<strong>The upload didn’t go through.</strong> Your details are still here. Select Try again. If it keeps failing, export the video again and replace the file.",
    SERVER: "<strong>We couldn’t reach the contest server.</strong> Your details are still here. Wait a moment, then select Try again.",
    SESSION_EXPIRED: "<strong>The upload link expired.</strong> Select Try again to start a fresh upload. Your details are still here.",
    DEADLINE_PASSED: "<strong>Submissions are closed.</strong> The deadline was November 25, 2026, 11:59 PM PHT, so this entry can’t be accepted.",
    UPLOAD_WINDOW_CLOSED: "<strong>The upload finished too late.</strong> Your entry was registered before the deadline, but the video didn’t finish uploading within the allowed time after midnight, so it can’t be accepted.",
    NOT_OPEN: "<strong>Submissions aren’t open yet.</strong> They open on November 11, 2026, 12:00 AM PHT.",
    RATE_LIMITED: "<strong>Too many attempts in a short time.</strong> Wait a few minutes, then select Try again.",
    FILE_REJECTED: "<strong>We couldn’t accept that video file.</strong> Make sure it’s a real video in " + limits.label + " format, under the size limit, then replace the file and try again.",
    BUSY: "<strong>The server is busy right now.</strong> Your details are still here. Select Try again in a moment.",
  };
  var RETRYABLE = { NETWORK: 1, UPLOAD: 1, SERVER: 1, SESSION_EXPIRED: 1, RATE_LIMITED: 1, BUSY: 1 };

  async function startAttempt(fields, renew) {
    setStage("Registering your entry…");
    var res = await api("init", {
      clientKey: state.attempt.clientKey,
      renew: !!renew,
      fields: fields,
      file: { name: state.file.name, size: state.file.size, type: state.file.type || "" },
    });
    if (res.alreadyComplete) return res.alreadyComplete;
    state.attempt.submissionId = res.submissionId;
    state.attempt.finalizeToken = res.finalizeToken;
    state.attempt.uploadUrl = res.uploadUrl;
    state.attempt.resume = false;
    state.attempt.fileId = null;
    return null;
  }

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    if (state.busy || state.done) return; // blocks double clicks / double Enter
    hideAlert();

    var fields = collectFields();
    if (!applyErrors(validate(fields))) return;
    if (!apiConfigured) { showAlert("<strong>The submission page isn’t connected yet.</strong> Please try again later.", false); return; }

    lock(true);
    try {
      if (!state.attempt || state.attempt.fileSig !== fileSig(state.file)) {
        state.attempt = { clientKey: uuid(), fileSig: fileSig(state.file) };
      }
      var a = state.attempt;

      if (!a.uploadUrl) {
        var done = await startAttempt(fields, false);
        if (done) return showSuccess(done);
      }

      if (!a.fileId) {
        try {
          a.fileId = await uploadFile(state.file, a);
        } catch (err) {
          if (err.code !== "SESSION_EXPIRED") throw err;
          var done2 = await startAttempt(fields, true);
          if (done2) return showSuccess(done2);
          a.fileId = await uploadFile(state.file, a);
        }
      }

      setStage("Checking your video and saving your entry…");
      var res = await api("finalize", {
        submissionId: a.submissionId,
        finalizeToken: a.finalizeToken,
        fileId: a.fileId,
        fields: fields,
      });
      showSuccess(res);
    } catch (err) {
      handleError(err);
    } finally {
      if (!state.done) lock(false);
    }
  });

  function handleError(err) {
    var code = (err && err.code) || "SERVER";
    if (code === "VALIDATION" && err.fieldErrors) {
      applyErrors(err.fieldErrors);
      showAlert("<strong>Some details need fixing.</strong> Check the highlighted fields, then submit again.", false);
      return;
    }
    if (code === "FILE_REJECTED" || code === "FILE_TOO_LARGE" || code === "BAD_TYPE") {
      state.attempt = null; // force a fresh attempt with a new file
      var msg = err.message ? "<strong>We couldn’t accept that video file.</strong> " + esc(err.message) : MESSAGES.FILE_REJECTED;
      showAlert(msg, false);
      dropzone.classList.add("is-invalid");
      return;
    }
    if (code === "DEADLINE_PASSED" || code === "UPLOAD_WINDOW_CLOSED") {
      showAlert(MESSAGES[code], false);
      loadStatus();
      return;
    }
    var text = MESSAGES[code] || (err.message ? "<strong>Something went wrong.</strong> " + esc(err.message) : MESSAGES.SERVER);
    showAlert(text, !!RETRYABLE[code] || !!err.retryable);
  }

  function showSuccess(r) {
    state.done = true;
    state.busy = false;
    try { sessionStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ }
    $("r-ref").textContent = r.reference;
    $("r-time").textContent = r.submittedAtDisplay || fmtPHT(new Date(r.submittedAt), true);
    $("r-title").textContent = r.entryTitle || "";
    $("r-file").textContent = r.fileName || "";
    $("r-email-note").textContent = r.emailSent ? "A copy of this confirmation was sent to " + r.email + "." : "";
    form.hidden = true;
    $("success").hidden = false;
    $("status-cta").hidden = true;
    $("success").focus();
    $("success").scrollIntoView({ block: "start", behavior: "smooth" });
  }

  window.addEventListener("beforeunload", function (e) {
    if (state.busy) { e.preventDefault(); e.returnValue = ""; }
  });

  /* ---------------- boot ---------------- */
  renderLimits();
  renderGraceNote();
  renderPhase();
  loadStatus();
  setInterval(renderPhase, 30000);
})();
