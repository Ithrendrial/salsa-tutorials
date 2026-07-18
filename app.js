/* Salsa Roja — vanilla JS, no build step.
   Data lives in moves.json in this repo, committed via the GitHub API.
   Videos upload straight to YouTube (unlisted) from the browser. */

let moves = [];
let activeTags = new Set(), query = "", sortNew = true, current = null, tagsExpanded = false, sessionsExpanded = false;

const $ = (id) => document.getElementById(id);
const esc = (s) => { const d = document.createElement("div"); d.textContent = s ?? ""; return d.innerHTML; };
const fmtDate = (iso) => new Date(iso + "T00:00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/* ============================================================
   Data: load + save moves.json via the GitHub Contents API
   ============================================================ */
const GH_API = () => `https://api.github.com/repos/${CONFIG.github.owner}/${CONFIG.github.repo}/contents/moves.json`;
const ghToken = () => localStorage.getItem("gh_token");

async function loadMoves() {
  // Prefer the GitHub API (always current); fall back to the copy GitHub
  // Pages serves alongside the site (can lag a fresh commit by ~a minute).
  try {
    const headers = { Accept: "application/vnd.github.raw+json" };
    if (ghToken()) headers.Authorization = "Bearer " + ghToken();
    const r = await fetch(`${GH_API()}?ref=${CONFIG.github.branch}`, { headers, cache: "no-store" });
    if (!r.ok) throw new Error();
    moves = await r.json();
  } catch {
    try { moves = await (await fetch("moves.json", { cache: "no-store" })).json(); }
    catch { moves = []; }
  }
  // Recover moves whose video uploaded but whose metadata commit failed
  const pending = JSON.parse(localStorage.getItem("pending") || "[]");
  for (const p of pending) if (!moves.some((m) => m.id === p.id)) moves.unshift(p);
  // Same for practice sessions whose video uploaded but save failed
  const ps = JSON.parse(localStorage.getItem("pendingSessions") || "[]");
  for (const p of ps) {
    const m = moves.find((m) => m.id === p.moveId);
    if (m && !(m.sessions || []).some((s) => s.id === p.session.id)) (m.sessions ||= []).unshift(p.session);
  }
  if ((pending.length || ps.length) && ghToken()) {
    commitMoves("Recover pending saves").catch(() => {});
  }
}

function askForToken() {
  return new Promise((resolve, reject) => {
    const dlg = $("token-dialog");
    dlg.showModal();
    $("token-form").onsubmit = (e) => {
      e.preventDefault();
      const t = $("token-input").value.trim();
      if (!t) return;
      localStorage.setItem("gh_token", t);
      $("token-input").value = "";
      dlg.close();
      resolve(t);
    };
    $("token-cancel").onclick = () => { dlg.close(); };
    dlg.onclose = () => { if (!ghToken()) reject(new Error("A GitHub token is needed to save")); };
  });
}

async function commitMoves(message) {
  const t = ghToken() || (await askForToken());
  const headers = { Authorization: "Bearer " + t, Accept: "application/vnd.github+json" };

  let sha; // current file sha, required by the API when updating
  const cur = await fetch(`${GH_API()}?ref=${CONFIG.github.branch}`, { headers, cache: "no-store" });
  if (cur.ok) sha = (await cur.json()).sha;

  const r = await fetch(GH_API(), {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message,
      branch: CONFIG.github.branch,
      content: btoa(unescape(encodeURIComponent(JSON.stringify(moves, null, 2)))),
      ...(sha && { sha }),
    }),
  });
  if (!r.ok) {
    if (r.status === 401) localStorage.removeItem("gh_token"); // bad token — re-ask next time
    throw new Error("Saving to GitHub failed (" + r.status + ")");
  }
  localStorage.setItem("pending", "[]");
  localStorage.setItem("pendingSessions", "[]");
}

/* ============================================================
   YouTube: sign in with Google, resumable upload, unlisted
   ============================================================ */
function googleAccessToken() {
  return new Promise((resolve, reject) => {
    if (typeof google === "undefined") {
      reject(new Error("Google sign-in didn't load — check your connection"));
      return;
    }
    google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.googleClientId,
      scope: "https://www.googleapis.com/auth/youtube.upload",
      callback: (r) => r.access_token ? resolve(r.access_token) : reject(new Error("Google sign-in failed")),
      error_callback: (e) => reject(new Error(e.message || "Google sign-in was cancelled")),
    }).requestAccessToken();
  });
}

async function uploadVideo(file, { name, notes, tags }, onProgress) {
  const gt = await googleAccessToken();

  const init = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + gt,
        "Content-Type": "application/json",
        "X-Upload-Content-Type": file.type || "video/mp4",
      },
      body: JSON.stringify({
        snippet: { title: name, description: notes, tags },
        status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false },
      }),
    }
  );
  if (!init.ok) throw new Error("YouTube rejected the upload (" + init.status + ") — check API quota and OAuth setup");
  const session = init.headers.get("Location");

  // XHR instead of fetch: upload progress events
  const video = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", session);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => xhr.status < 300
      ? resolve(JSON.parse(xhr.responseText))
      : reject(new Error("Upload failed (" + xhr.status + ")"));
    xhr.onerror = () => reject(new Error("Upload failed — network error"));
    xhr.send(file);
  });
  return video.id;
}

/* ============================================================
   Views / routing (#/ library, #/new, #/move/{videoId})
   ============================================================ */
function show(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $("view-" + view).classList.add("active");
  const sub = view !== "library"; // subpage: back arrow left, app name right
  document.body.classList.toggle("subpage", sub);
  $("backBtn").hidden = !sub;
  window.scrollTo(0, 0);
}
$("backBtn").onclick = () => history.length > 1 ? history.back() : (location.hash = "#/");

function route() {
  const h = location.hash;
  if (h.startsWith("#/move/")) {
    openDetail(decodeURIComponent(h.slice(7)));
  } else if (h.startsWith("#/log/")) {
    const [mid, sid] = h.slice(6).split("/");
    openLog(decodeURIComponent(mid), sid);
  } else if (h === "#/new") {
    show("new");
  } else {
    show("library"); // must be visible before renderChips measures tag rows
    renderChips();
    renderGrid();
  }
}

/* ---------- Library ---------- */
const allTags = () => [...new Set(moves.flatMap((m) => m.tags))].sort();

function renderChips() {
  const strip = $("chipStrip");
  strip.innerHTML = "";
  const tags = allTags();
  for (const t of [...activeTags]) if (!tags.includes(t)) activeTags.delete(t);
  // Selected tags float to the front so they stay visible even when collapsed.
  const ordered = [...tags].sort((a, b) =>
    (activeTags.has(b) - activeTags.has(a)) || a.localeCompare(b));
  const mk = (label, on, onclick) => {
    const b = document.createElement("button");
    b.className = "chip" + (on ? " on" : "");
    b.textContent = label;
    b.onclick = () => { onclick(); renderChips(); renderGrid(); };
    strip.appendChild(b);
  };
  mk("All", activeTags.size === 0, () => activeTags.clear());
  ordered.forEach((t) => mk(t, activeTags.has(t),
    () => activeTags.has(t) ? activeTags.delete(t) : activeTags.add(t)));
  updateChipMore();
}

// Clamp the tag list to 2 rows with a See more/less toggle when it overflows.
function updateChipMore() {
  const strip = $("chipStrip"), more = $("chipMore");
  strip.classList.remove("collapsed");
  const chip = strip.querySelector(".chip");
  if (!chip) { more.hidden = true; return; }
  const twoRows = chip.offsetHeight * 2 + 8; // 8 = row gap
  strip.style.setProperty("--two-rows", twoRows + "px");
  if (strip.scrollHeight <= twoRows + 1) { more.hidden = true; return; }
  more.hidden = false;
  if (!tagsExpanded) strip.classList.add("collapsed");
  more.textContent = tagsExpanded ? "See less" : "See more";
}

function visibleMoves() {
  const q = query.toLowerCase();
  return moves
    .filter((m) =>
      (activeTags.size === 0 || [...activeTags].every((t) => m.tags.includes(t))) && // move must have ALL selected tags
      (!q || m.name.toLowerCase().includes(q) ||
        m.tags.join(" ").toLowerCase().includes(q) ||
        (m.notes || "").toLowerCase().includes(q)))
    .sort((a, b) => sortNew ? (b.created || "").localeCompare(a.created || "") : a.name.localeCompare(b.name));
}

function renderGrid() {
  const g = $("grid");
  const list = visibleMoves();
  g.innerHTML = "";
  if (!list.length) {
    g.innerHTML = moves.length
      ? '<div class="empty">No results.</div>'
      : '<div class="empty">No moves.<br><a class="btn-primary" href="#/new">Add your first move</a></div>';
    return;
  }
  for (const m of list) {
    const card = document.createElement("a");
    card.className = "card";
    card.href = "#/move/" + encodeURIComponent(m.id);
    card.style.textDecoration = "none";
    card.style.color = "inherit";
    card.innerHTML = `
      <div class="thumb">
        <img src="https://i.ytimg.com/vi/${encodeURIComponent(m.id)}/mqdefault.jpg" alt="" loading="lazy"
             onerror="this.remove()">
        <div class="play"><svg width="16" height="16" viewBox="0 0 22 22" fill="white"><path d="M4 2l16 9-16 9z"/></svg></div>
      </div>
      <div class="card-body">
        <h3 class="card-name display">${esc(m.name)}</h3>
        <div class="card-tags">${m.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
        <div class="card-date">Added ${m.created ? fmtDate(m.created) : "—"}</div>
      </div>`;
    g.appendChild(card);
  }
}

/* ---------- Detail / edit ---------- */
function openDetail(id) {
  current = moves.find((m) => m.id === id);
  if (!current) { location.hash = "#/"; return; }
  $("detail").classList.remove("editing");
  $("d-player").innerHTML =
    `<iframe src="https://www.youtube.com/embed/${encodeURIComponent(id)}?rel=0" allowfullscreen
             allow="accelerometer; encrypted-media; gyroscope; picture-in-picture" title="${esc(current.name)}"></iframe>`;
  $("d-name").textContent = current.name;
  $("d-tags").innerHTML = current.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("");
  $("d-meta").textContent = `Added ${current.created ? fmtDate(current.created) : "—"}`;
  $("d-notes").innerHTML = current.notes
    ? current.notes.split("\n").filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join("")
    : '<p class="hint">No notes yet - edit to add.</p>';
  sessionsExpanded = false;
  renderPractice();
  show("detail");
}

/* ---------- Practice sessions ---------- */
const SHOE_SVG = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M3.35529 7.25291C4.00529 7.25291 4.62196 7.36957 5.20529 7.60291C5.78863 7.83624 6.32196 8.17791 6.80529 8.62791L16.3553 17.7529H16.9553C17.2386 17.7529 17.4761 17.6571 17.6678 17.4654C17.8595 17.2737 17.9553 17.0362 17.9553 16.7529C17.9553 16.6196 17.9428 16.4779 17.9178 16.3279C17.8928 16.1779 17.8053 16.0279 17.6553 15.8779L13.0803 11.3029L11.3053 5.95291L9.45529 6.40291C8.82196 6.56957 8.24696 6.45291 7.73029 6.05291C7.21363 5.65291 6.95529 5.12791 6.95529 4.47791V2.37791L6.25529 2.02791L2.40529 7.17791C2.38863 7.19457 2.38029 7.20707 2.38029 7.21541C2.38029 7.22374 2.37196 7.23624 2.35529 7.25291H3.35529ZM3.35529 9.25291H2.20529C2.25529 9.36957 2.31779 9.47791 2.39279 9.57791C2.46779 9.67791 2.55529 9.76957 2.65529 9.85291L10.7553 17.2279C10.9386 17.4112 11.147 17.5446 11.3803 17.6279C11.6136 17.7112 11.8553 17.7529 12.1053 17.7529H13.4553L5.43029 10.0779C5.14696 9.79457 4.82613 9.58624 4.46779 9.45291C4.10946 9.31957 3.73863 9.25291 3.35529 9.25291ZM12.1053 19.7529C11.6053 19.7529 11.1303 19.6612 10.6803 19.4779C10.2303 19.2946 9.81363 19.0362 9.43029 18.7029L1.30529 11.3279C0.538628 10.6279 0.109461 9.76957 0.0177941 8.75291C-0.0738726 7.73624 0.188627 6.81124 0.805294 5.97791L4.65529 0.827907C4.93863 0.444574 5.31779 0.190407 5.79279 0.065407C6.26779 -0.059593 6.72196 -0.00542636 7.15529 0.227907L7.85529 0.577907C8.20529 0.76124 8.47613 1.01124 8.66779 1.32791C8.85946 1.64457 8.95529 1.99457 8.95529 2.37791V4.47791L10.8053 4.00291C11.3053 3.86957 11.7886 3.93207 12.2553 4.19041C12.722 4.44874 13.0386 4.81957 13.2053 5.30291L14.8303 10.2029L19.0803 14.4529C19.4136 14.7862 19.6428 15.1446 19.7678 15.5279C19.8928 15.9112 19.9553 16.3196 19.9553 16.7529C19.9553 17.5862 19.6636 18.2946 19.0803 18.8779C18.497 19.4612 17.7886 19.7529 16.9553 19.7529H12.1053Z" fill="currentColor"/></svg>';

const moveSessions = (m) => [...(m.sessions || [])].sort(
  (a, b) => (b.date || "").localeCompare(a.date || "") || (b.id || 0) - (a.id || 0));

function renderPractice() {
  const sessions = moveSessions(current);
  $("d-count").textContent = sessions.length + (sessions.length === 1 ? " time" : " times");
  $("logBtn").href = "#/log/" + encodeURIComponent(current.id);
  const list = $("sessionList");
  list.innerHTML = "";
  if (!sessions.length) {
    list.innerHTML = '<div class="session-none">No sessions yet — log your first practice.</div>';
  }
  for (const s of (sessionsExpanded ? sessions : sessions.slice(0, 3))) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "session-item";
    b.innerHTML = `
      <span class="session-thumb">${s.videoId
        ? `<img src="https://i.ytimg.com/vi/${encodeURIComponent(s.videoId)}/mqdefault.jpg" alt="" loading="lazy" onerror="this.remove()">`
        : SHOE_SVG}</span>
      <span class="session-date">${s.date ? fmtDate(s.date) : "—"}</span>
      ${s.rating
        ? `<span class="stars-sm"><span class="fill">${"★".repeat(s.rating)}</span><span class="rest">${"★".repeat(5 - s.rating)}</span></span>`
        : '<span class="session-none">Not rated</span>'}`;
    b.onclick = () => { location.hash = "#/log/" + encodeURIComponent(current.id) + "/" + s.id; };
    list.appendChild(b);
  }
  const va = $("viewAllBtn");
  va.hidden = sessions.length <= 3;
  va.textContent = sessionsExpanded ? "Show Less" : "View All";
}
$("viewAllBtn").onclick = () => { sessionsExpanded = !sessionsExpanded; renderPractice(); };

$("editBtn").onclick = () => {
  $("e-name").value = current.name;
  $("e-tags").value = current.tags.join(", ");
  $("e-notes").value = current.notes || "";
  $("detail").classList.add("editing");
};
$("editCancel").onclick = () => $("detail").classList.remove("editing");

$("deleteBtn").onclick = async () => {
  if (!confirm("Are you sure you want to delete this move?")) return;
  const idx = moves.findIndex((m) => m.id === current.id);
  const [removed] = moves.splice(idx, 1);
  try {
    await commitMoves("Delete move: " + removed.name);
    location.hash = "#/";
    toast("Deleted");
  } catch (err) {
    moves.splice(idx, 0, removed);
    toast(err.message);
  }
};

$("edit-form").onsubmit = async (e) => {
  e.preventDefault();
  const name = $("e-name").value.trim();
  if (!name) { toast("Move name is required"); return; }
  const before = { name: current.name, tags: current.tags, notes: current.notes };
  current.name = name;
  current.tags = $("e-tags").value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  current.notes = $("e-notes").value.trim();
  try {
    await commitMoves("Edit move: " + name);
    openDetail(current.id);
    toast("Saved");
  } catch (err) {
    Object.assign(current, before); // roll back so the UI matches what's stored
    toast(err.message);
  }
};

/* ---------- Log / edit practice session ---------- */
let logMove = null, logSession = null, sRating = 0;

function setRating(n) {
  sRating = n;
  document.querySelectorAll("#s-stars button").forEach((b) =>
    b.classList.toggle("on", +b.dataset.v <= n));
}
document.querySelectorAll("#s-stars button").forEach((b) => {
  b.onclick = () => setRating(+b.dataset.v === sRating ? 0 : +b.dataset.v); // tap current star to clear
});

function openLog(moveId, sessionId) {
  logMove = moves.find((m) => m.id === moveId);
  if (!logMove) { location.hash = "#/"; return; }
  logSession = sessionId ? (logMove.sessions || []).find((s) => String(s.id) === sessionId) : null;
  if (sessionId && !logSession) { location.hash = "#/move/" + encodeURIComponent(moveId); return; }

  $("log-move-thumb").innerHTML =
    `<img src="https://i.ytimg.com/vi/${encodeURIComponent(logMove.id)}/mqdefault.jpg" alt="" onerror="this.remove()">`;
  $("log-move-name").textContent = logMove.name;

  // Existing sessions open read-only; the ⋯ menu switches to edit
  if (logSession) renderSessionRead(); else openSessionForm();
  show("log");
}

const starsHtml = (r) =>
  `<span class="fill">${"★".repeat(r)}</span><span class="rest">${"★".repeat(5 - r)}</span>`;

function renderSessionRead() {
  $("log-title").textContent = logSession.date ? fmtDate(logSession.date) : "Practice Session";
  $("svMenuWrap").hidden = false;
  $("svMenu").hidden = true;
  $("sv-stars").innerHTML = logSession.rating
    ? starsHtml(logSession.rating)
    : '<span class="session-none">Not rated</span>';
  const hasVid = !!logSession.videoId;
  $("sv-player").hidden = !hasVid;
  $("sv-player").innerHTML = hasVid
    ? `<iframe src="https://www.youtube.com/embed/${encodeURIComponent(logSession.videoId)}?rel=0" allowfullscreen title="Practice video"></iframe>`
    : "";
  $("sv-notes").innerHTML = logSession.notes
    ? logSession.notes.split("\n").filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join("")
    : '<p class="hint">No notes for this session.</p>';
  $("session-read").hidden = false;
  $("log-form").hidden = true;
}

function openSessionForm() {
  $("log-title").textContent = logSession ? "Edit Session" : "Log Practice";
  $("svMenuWrap").hidden = true;
  $("s-submit").textContent = logSession ? "Save Changes" : "Add Session";

  $("s-date").value = logSession?.date || new Date().toISOString().slice(0, 10);
  $("s-notes").value = logSession?.notes || "";
  setRating(logSession?.rating || 0);

  // Video: new sessions can attach one; editing shows the existing video.
  // ponytail: no replacing a session's video on edit - delete + re-log covers it
  $("s-file").value = "";
  $("s-drop-idle").hidden = false;
  $("s-drop-done").hidden = true;
  $("s-drop").classList.remove("armed");
  const hasVid = !!logSession?.videoId;
  $("s-drop").hidden = !!logSession;
  $("s-player").hidden = !hasVid;
  $("s-player").innerHTML = hasVid
    ? `<iframe src="https://www.youtube.com/embed/${encodeURIComponent(logSession.videoId)}?rel=0" allowfullscreen title="Practice video"></iframe>`
    : "";
  $("s-novideo").hidden = !(logSession && !hasVid);

  $("session-read").hidden = true;
  $("log-form").hidden = false;
}

$("svMenuBtn").onclick = () => { $("svMenu").hidden = !$("svMenu").hidden; };
document.addEventListener("click", (e) => {
  if (!e.target.closest(".menu-wrap")) $("svMenu").hidden = true;
});
$("svEdit").onclick = () => { $("svMenu").hidden = true; openSessionForm(); };

$("s-cancel").onclick = () => {
  if (logSession) renderSessionRead(); // back to view mode
  else location.hash = "#/move/" + encodeURIComponent(logMove.id);
};

$("s-file").addEventListener("change", () => {
  const f = $("s-file").files[0];
  if (!f) return;
  $("s-drop-filename").textContent = f.name + " · " + (f.size / 1048576).toFixed(0) + " MB";
  $("s-drop-idle").hidden = true;
  $("s-drop-done").hidden = false;
  $("s-drop").classList.add("armed");
});

function setSProgress(frac, label) {
  $("s-progFill").style.width = Math.round(frac * 100) + "%";
  $("s-progPct").textContent = Math.round(frac * 100) + "%";
  if (label) $("s-progText").textContent = label;
}

$("log-form").onsubmit = async (e) => {
  e.preventDefault();
  const date = $("s-date").value;
  if (!date) { toast("Practice date is required"); return; }
  const notes = $("s-notes").value.trim();
  const file = logSession ? null : $("s-file").files[0];

  $("view-log").classList.add("uploading");
  if (file) { $("s-prog").classList.add("active"); setSProgress(0, "Uploading to YouTube…"); }
  try {
    let videoId = logSession ? (logSession.videoId ?? null) : null;
    if (file) {
      videoId = await uploadVideo(file,
        { name: logMove.name + " — practice " + date, notes, tags: logMove.tags },
        setSProgress);
      setSProgress(1, "Saving to your vault…");
    }
    const sessions = (logMove.sessions = logMove.sessions || []);
    const prev = logSession ? { ...logSession } : null;
    if (logSession) Object.assign(logSession, { date, rating: sRating, notes });
    else sessions.unshift({ id: Date.now(), date, rating: sRating, notes, videoId });
    try {
      await commitMoves((logSession ? "Edit" : "Log") + " practice: " + logMove.name);
      toast(logSession ? "Session updated" : "Session logged");
    } catch (err) {
      if (!logSession && videoId) {
        // The video IS on YouTube - keep the session and retry the save next visit
        const ps = JSON.parse(localStorage.getItem("pendingSessions") || "[]");
        ps.push({ moveId: logMove.id, session: sessions[0] });
        localStorage.setItem("pendingSessions", JSON.stringify(ps));
        toast("Video uploaded, but saving failed — it will retry on your next visit");
      } else {
        if (logSession) Object.assign(logSession, prev);
        else sessions.shift();
        throw err;
      }
    }
    location.hash = "#/move/" + encodeURIComponent(logMove.id);
  } catch (err) {
    toast(err.message);
  } finally {
    $("view-log").classList.remove("uploading");
    $("s-prog").classList.remove("active");
  }
};

$("svDelete").onclick = async () => {
  $("svMenu").hidden = true;
  if (!confirm("Are you sure you want to delete this session?")) return;
  const sessions = logMove.sessions;
  const idx = sessions.indexOf(logSession);
  sessions.splice(idx, 1);
  try {
    await commitMoves("Delete practice: " + logMove.name);
    location.hash = "#/move/" + encodeURIComponent(logMove.id);
    toast("Session deleted");
  } catch (err) {
    sessions.splice(idx, 0, logSession);
    toast(err.message);
  }
};

/* ---------- New move ---------- */
function readTagChips() {
  const typed = $("f-tags").value.trim().toLowerCase(); // include un-entered text too
  const chips = [...$("tagbox").querySelectorAll(".tag")].map((c) => c.dataset.value);
  if (typed) chips.push(...typed.split(",").map((s) => s.trim()).filter(Boolean));
  return [...new Set(chips)];
}

function addTagChip(value) {
  const v = value.trim().toLowerCase().replace(/,+$/, "");
  if (!v) return;
  const chip = document.createElement("span");
  chip.className = "tag";
  chip.dataset.value = v;
  chip.append(v);
  const x = document.createElement("button");
  x.type = "button";
  x.setAttribute("aria-label", "Remove tag " + v);
  x.textContent = "×";
  x.onclick = () => chip.remove();
  chip.append(" ", x);
  $("tagbox").insertBefore(chip, $("f-tags"));
}

$("f-tags").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
    addTagChip(e.target.value);
    e.target.value = "";
  }
});

$("f-file").addEventListener("change", () => {
  const f = $("f-file").files[0];
  if (!f) return;
  $("drop-filename").textContent = f.name + " · " + (f.size / 1048576).toFixed(0) + " MB";
  $("drop-idle").hidden = true;
  $("drop-done").hidden = false;
  $("drop").classList.add("armed");
});
const drop = $("drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("dragover"); });
drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("dragover");
  if (e.dataTransfer.files.length) {
    $("f-file").files = e.dataTransfer.files;
    $("f-file").dispatchEvent(new Event("change"));
  }
});

// Pull the 11-char video ID out of any YouTube URL shape (or a bare ID)
function extractYouTubeId(input) {
  const s = String(input).trim();
  const m = s.match(/(?:shorts\/|youtu\.be\/|watch\?v=|embed\/|\/v\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  return null;
}

let videoMode = "upload"; // "upload" (new file) or "link" (existing video)
document.querySelectorAll("#videoMode .seg-btn").forEach((b) => {
  b.onclick = () => {
    videoMode = b.dataset.mode;
    document.querySelectorAll("#videoMode .seg-btn").forEach((x) => x.classList.toggle("on", x === b));
    $("drop").hidden = videoMode !== "upload";
    $("linkField").hidden = videoMode !== "link";
    $("new-form").querySelector('button[type=submit]').textContent =
      videoMode === "link" ? "Add move" : "Upload & save";
  };
});

function setProgress(frac, label) {
  $("progFill").style.width = Math.round(frac * 100) + "%";
  $("progPct").textContent = Math.round(frac * 100) + "%";
  if (label) $("progText").textContent = label;
}

$("new-form").onsubmit = async (e) => {
  e.preventDefault();
  const name = $("f-name").value.trim();
  if (!name) { toast("Move name is required"); return; }

  const move = {
    id: null,
    name,
    tags: readTagChips(),
    notes: $("f-notes").value.trim(),
    created: new Date().toISOString().slice(0, 10),
  };

  // Link mode: no upload — just take the ID from the pasted URL and save.
  if (videoMode === "link") {
    const vid = extractYouTubeId($("f-url").value);
    if (!vid) { toast("Paste a valid YouTube link"); return; }
    if (moves.some((m) => m.id === vid)) { toast("That video is already in your vault"); return; }
    move.id = vid;
    moves.unshift(move);
    try {
      await commitMoves("Add move: " + name);
      resetNewForm();
      location.hash = "#/";
      toast("Added " + name);
    } catch (err) {
      moves.splice(moves.indexOf(move), 1);
      toast(err.message);
    }
    return;
  }

  const file = $("f-file").files[0];
  if (!file) { toast("Choose a video file to upload"); return; }
  if (CONFIG.googleClientId.startsWith("YOUR_")) { toast("Fill in config.js first — see the README"); return; }

  $("view-new").classList.add("uploading");
  $("prog").classList.add("active");
  setProgress(0, "Uploading to YouTube…");
  try {
    move.id = await uploadVideo(file, { name, notes: move.notes, tags: move.tags }, setProgress);
    setProgress(1, "Saving to your vault…");
    moves.unshift(move);
    let saved = true;
    try {
      await commitMoves("Add move: " + name);
    } catch {
      // The video IS on YouTube — never lose the metadata. Retry on next visit.
      saved = false;
      const pending = JSON.parse(localStorage.getItem("pending") || "[]");
      pending.push(move);
      localStorage.setItem("pending", JSON.stringify(pending));
    }
    resetNewForm();
    location.hash = "#/";
    toast(saved ? "Uploaded — " + name + " added to your vault"
                : "Video uploaded, but saving the vault failed — it will retry on your next visit");
  } catch (err) {
    toast(err.message);
  } finally {
    $("view-new").classList.remove("uploading");
    $("prog").classList.remove("active");
  }
};

function resetNewForm() {
  $("new-form").reset();
  $("tagbox").querySelectorAll(".tag").forEach((c) => c.remove());
  $("drop-idle").hidden = false;
  $("drop-done").hidden = true;
  $("drop").classList.remove("armed");
  document.querySelector('#videoMode .seg-btn[data-mode=upload]').click(); // back to upload mode
}

/* ---------- Shared ---------- */
let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

$("q").addEventListener("input", (e) => {
  query = e.target.value;
  if (location.hash !== "#/" && location.hash !== "") location.hash = "#/";
  renderGrid();
});

$("sortBtn").addEventListener("click", (e) => {
  sortNew = !sortNew;
  e.target.textContent = sortNew ? "Newest ↓" : "A–Z ↓";
  renderGrid();
});

$("chipMore").addEventListener("click", () => { tagsExpanded = !tagsExpanded; updateChipMore(); });
window.addEventListener("resize", updateChipMore);

window.addEventListener("hashchange", route);
loadMoves().then(route);
