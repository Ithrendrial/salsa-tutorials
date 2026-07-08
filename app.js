/* Salsa Vault — vanilla JS, no build step.
   Data lives in moves.json in this repo, committed via the GitHub API.
   Videos upload straight to YouTube (unlisted) from the browser. */

let moves = [];
let activeTag = null, query = "", sortNew = true, current = null;

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
  if (pending.length && ghToken()) {
    commitMoves("Recover " + pending.length + " pending move(s)").catch(() => {});
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
  window.scrollTo(0, 0);
}

function route() {
  const h = location.hash;
  if (h.startsWith("#/move/")) {
    openDetail(decodeURIComponent(h.slice(7)));
  } else if (h === "#/new") {
    show("new");
  } else {
    renderChips();
    renderGrid();
    show("library");
  }
}

/* ---------- Library ---------- */
const allTags = () => [...new Set(moves.flatMap((m) => m.tags))].sort();

function renderChips() {
  const rail = $("chips");
  rail.querySelectorAll(".chip").forEach((c) => c.remove());
  if (activeTag && !allTags().includes(activeTag)) activeTag = null;
  const mk = (label, val) => {
    const b = document.createElement("button");
    b.className = "chip" + (val === activeTag ? " on" : "");
    b.textContent = label;
    b.onclick = () => { activeTag = val; renderChips(); renderGrid(); };
    rail.insertBefore(b, $("sortBtn"));
  };
  mk("All", null);
  allTags().forEach((t) => mk(t, t));
}

function visibleMoves() {
  const q = query.toLowerCase();
  return moves
    .filter((m) =>
      (!activeTag || m.tags.includes(activeTag)) &&
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
      ? '<div class="empty">No moves match — try clearing the filter.</div>'
      : '<div class="empty">Your vault is empty.<br><a class="btn-primary" href="#/new">Add your first move</a></div>';
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
  $("d-meta").textContent = `Added ${current.created ? fmtDate(current.created) : "—"} · Unlisted on YouTube`;
  $("d-notes").innerHTML = current.notes
    ? current.notes.split("\n").filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join("")
    : '<p class="hint">No notes yet — tap Edit to add some.</p>';
  show("detail");
}

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

/* ---------- New move ---------- */
function readTagChips() {
  const typed = $("f-tags").value.trim().toLowerCase(); // include un-entered text too
  const chips = [...$("tagbox").querySelectorAll(".tag")].map((c) => c.dataset.value);
  if (typed) chips.push(typed);
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

function setProgress(frac, label) {
  $("progFill").style.width = Math.round(frac * 100) + "%";
  $("progPct").textContent = Math.round(frac * 100) + "%";
  if (label) $("progText").textContent = label;
}

$("new-form").onsubmit = async (e) => {
  e.preventDefault();
  const name = $("f-name").value.trim();
  const file = $("f-file").files[0];
  if (!name || !file) { toast("Move name and video file are required"); return; }
  if (CONFIG.googleClientId.startsWith("YOUR_")) { toast("Fill in config.js first — see the README"); return; }

  const move = {
    id: null,
    name,
    tags: readTagChips(),
    notes: $("f-notes").value.trim(),
    created: new Date().toISOString().slice(0, 10),
  };

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

window.addEventListener("hashchange", route);
loadMoves().then(route);
