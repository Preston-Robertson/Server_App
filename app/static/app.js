// Game Server Manager — dashboard JS.
// Token in localStorage; sent as Bearer on every /api call.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let TOKEN = localStorage.getItem("gamesrv_token") || "";
let CURRENT = null;              // currently open server name
let CURRENT_PAGE = "dashboard";
let SERVERS_TIMER = null;
let UPDATE_LOG_TIMER = null;

// ---------- auth badge ----------

function refreshAuthBadge() {
  const el = $("#auth-badge");
  if (!el) return;
  if (TOKEN) {
    el.textContent = "token loaded";
    el.className = "ok";
  } else {
    el.textContent = "no token — set on Admin page";
    el.className = "warn";
  }
}

// ---------- page switching ----------

function showPage(name) {
  CURRENT_PAGE = name;
  $("#page-dashboard").hidden = name !== "dashboard";
  $("#page-admin").hidden = name !== "admin";
  $$(".tab").forEach(b => b.classList.toggle("active", b.dataset.page === name));

  clearInterval(SERVERS_TIMER); SERVERS_TIMER = null;
  clearInterval(UPDATE_LOG_TIMER); UPDATE_LOG_TIMER = null;

  if (name === "dashboard") {
    refreshServers();
    SERVERS_TIMER = setInterval(refreshServers, 5000);
  } else if (name === "admin") {
    $("#token").value = TOKEN;
    if ($("#follow-update-log").checked) startFollowUpdateLog();
  }
}
$$(".tab").forEach(b => b.onclick = () => showPage(b.dataset.page));

// ---------- API ----------

async function api(path, opts = {}) {
  const headers = Object.assign(
    { "Authorization": "Bearer " + TOKEN },
    opts.body instanceof FormData ? {} : { "Content-Type": "application/json" },
    opts.headers || {},
  );
  const r = await fetch(path, Object.assign({}, opts, { headers }));
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("application/json") ? await r.json() : await r.text();
  if (!r.ok) {
    const msg = typeof body === "string" ? body : (body.detail || JSON.stringify(body));
    throw new Error(`HTTP ${r.status}: ${msg}`);
  }
  return body;
}

function fmtBytes(n) {
  if (n == null) return "-";
  const u = ["B","KB","MB","GB","TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function fmtDur(s) {
  if (s == null) return "-";
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}
function fmtTime(ts) { return ts ? new Date(ts * 1000).toLocaleString() : "-"; }

// Map systemd ActiveState to a chip class + friendly label.
function stateChip(active, sub) {
  const s = (active || "unknown").toLowerCase();
  if (s === "active")     return { cls: "chip-ok",    label: `● ${sub || "running"}` };
  if (s === "activating") return { cls: "chip-warn",  label: `◐ ${sub || "starting"}` };
  if (s === "deactivating") return { cls: "chip-warn", label: `◑ ${sub || "stopping"}` };
  if (s === "failed")     return { cls: "chip-err",   label: `✕ failed` };
  if (s === "inactive")   return { cls: "chip-muted", label: `○ stopped` };
  return { cls: "chip-muted", label: s };
}

// ========================================================================
// ADMIN
// ========================================================================

$("#save-token").onclick = () => {
  TOKEN = $("#token").value.trim();
  localStorage.setItem("gamesrv_token", TOKEN);
  refreshAuthBadge();
  setTokenStatus("saved", "ok");
};
$("#clear-token").onclick = () => {
  TOKEN = "";
  localStorage.removeItem("gamesrv_token");
  $("#token").value = "";
  refreshAuthBadge();
  setTokenStatus("cleared", "");
};
$("#test-token").onclick = async () => {
  try {
    const rows = await api("/api/servers");
    setTokenStatus(`ok — ${rows.length} server(s) registered`, "ok");
  } catch (e) {
    setTokenStatus("FAIL: " + e.message, "err");
  }
};
function setTokenStatus(msg, cls) {
  const el = $("#token-status");
  el.textContent = msg;
  el.className = "muted " + (cls || "");
}

$("#manager-update").onclick = async () => {
  if (!confirm(
    "Pull the latest commit from GitHub and restart the manager?\n\n" +
    "The UI may drop for ~10s. On failure the manager auto-rolls back " +
    "to the previous commit."
  )) return;
  try {
    const r = await api("/api/manager/update", { method: "POST" });
    $("#update-log-out").textContent = "triggered: " + JSON.stringify(r, null, 2) +
      "\n\n(waiting for update.log to populate...)\n";
    $("#follow-update-log").checked = true;
    startFollowUpdateLog();
  } catch (e) {
    alert("Trigger failed: " + e.message);
  }
};

async function refreshUpdateLog() {
  try {
    const txt = await api("/api/manager/update/log?lines=400");
    const pre = $("#update-log-out");
    pre.textContent = txt || "(update.log is empty)";
    pre.scrollTop = pre.scrollHeight;
  } catch (e) {
    $("#update-log-out").textContent = "ERROR: " + e.message;
  }
}
$("#refresh-update-log").onclick = refreshUpdateLog;
function startFollowUpdateLog() {
  clearInterval(UPDATE_LOG_TIMER);
  refreshUpdateLog();
  UPDATE_LOG_TIMER = setInterval(refreshUpdateLog, 3000);
}
$("#follow-update-log").onchange = (ev) => {
  if (ev.target.checked) startFollowUpdateLog();
  else clearInterval(UPDATE_LOG_TIMER);
};

$("#check-health").onclick = async () => {
  const badge = $("#health-status");
  try {
    const r = await fetch("/healthz");
    const t = await r.text();
    badge.textContent = r.ok ? `OK (${t.trim()})` : `FAIL: HTTP ${r.status}`;
    badge.className = r.ok ? "muted ok" : "muted err";
  } catch (e) {
    badge.textContent = "FAIL: " + e.message;
    badge.className = "muted err";
  }
};

// ========================================================================
// DASHBOARD — server cards
// ========================================================================

async function refreshServers() {
  if (!TOKEN) return;
  try {
    const rows = await api("/api/servers");
    renderServerGrid(rows);
    const badge = $("#auth-badge");
    if (badge && badge.classList.contains("err")) { badge.textContent = "token loaded"; badge.className = "ok"; }
  } catch (e) {
    const badge = $("#auth-badge");
    if (badge) { badge.textContent = "auth error — check Admin page"; badge.className = "err"; }
  }
}

function renderServerGrid(rows) {
  const grid = $("#server-grid");
  const empty = $("#server-empty");
  grid.innerHTML = "";
  if (!rows.length) { empty.hidden = false; return; }
  empty.hidden = true;

  for (const r of rows) {
    const d = r.def, s = r.status;
    const chip = stateChip(s.active, s.sub);

    // RAM % of the cap.
    const capBytes = (d.memory_mb || 0) * 1024 * 1024;
    let pct = 0;
    let barCls = "";
    if (capBytes > 0 && s.mem_bytes != null && s.mem_bytes > 0) {
      pct = Math.min(100, (s.mem_bytes / capBytes) * 100);
      if (pct > 90) barCls = "err";
      else if (pct > 75) barCls = "warn";
    }
    const ramLabel = s.mem_bytes != null
      ? `${fmtBytes(s.mem_bytes)} / ${d.memory_mb} MB`
      : `— / ${d.memory_mb} MB`;

    const card = document.createElement("div");
    card.className = "server-card" + (CURRENT === d.name ? " selected" : "");
    card.dataset.name = d.name;
    card.innerHTML = `
      <div class="server-card-head">
        <h3 class="server-card-name" data-open="${d.name}">${escape(d.name)}</h3>
        <span class="server-card-type">${escape(d.type)}</span>
      </div>
      <div class="server-card-chips">
        <span class="chip ${chip.cls}">${chip.label}</span>
        <span class="chip">:${d.port}</span>
        ${s.enabled === "enabled" ? '<span class="chip chip-accent">on boot</span>' : ''}
        ${s.console_available ? '<span class="chip">console</span>' : ''}
      </div>
      <div class="server-card-meta">
        <div class="ram-bar" title="${ramLabel}">
          <div class="ram-bar-fill ${barCls}" style="width:${pct.toFixed(1)}%"></div>
        </div>
        <div class="row">
          <span>RAM ${ramLabel}</span>
          <span>Uptime ${fmtDur(s.uptime_sec)}</span>
        </div>
      </div>
      <div class="server-card-actions">
        <button class="btn btn-tiny btn-success" data-quick="start"   data-name="${d.name}">▶ Start</button>
        <button class="btn btn-tiny btn-danger"  data-quick="stop"    data-name="${d.name}">■ Stop</button>
        <button class="btn btn-tiny"             data-quick="restart" data-name="${d.name}">↻</button>
        <button class="btn btn-tiny btn-ghost"   data-open="${d.name}">Open →</button>
      </div>
    `;
    grid.appendChild(card);
  }
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

document.addEventListener("click", async (ev) => {
  const t = ev.target;
  if (t.dataset.open)  { ev.preventDefault(); openServer(t.dataset.open); return; }
  if (t.dataset.quick) {
    try {
      await api(`/api/servers/${t.dataset.name}/action`, {
        method: "POST", body: JSON.stringify({ action: t.dataset.quick }),
      });
      setTimeout(refreshServers, 500);
    } catch (e) { alert(e.message); }
  }
});

$("#refresh").onclick = refreshServers;
$("#detail-close").onclick = () => { CURRENT = null; $("#detail-panel").hidden = true; refreshServers(); };
$("#new-server").onclick = () => openNewServerModal();

// ---------- server detail ----------

async function openServer(name) {
  CURRENT = name;
  $("#detail-panel").hidden = false;
  $("#detail-title").textContent = name;
  showTab("control");
  refreshServers();  // to re-highlight the selected card
  $("#detail-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function showTab(name) {
  $$(".subtab").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  $$(".subtab-body").forEach(b => b.hidden = b.dataset.body !== name);
  if (name === "logs") loadLogs();
  if (name === "files") listFiles();
  if (name === "backups") loadBackups();
  if (name === "def") loadDef();
}
$$(".subtab").forEach(b => b.onclick = () => showTab(b.dataset.tab));

// Control tab
document.addEventListener("click", async (ev) => {
  const action = ev.target.dataset.action;
  if (!action || !CURRENT) return;
  try {
    let path;
    if (action === "install") path = `/api/servers/${CURRENT}/install`;
    else if (action === "update-type") path = `/api/servers/${CURRENT}/update`;
    else path = `/api/servers/${CURRENT}/action`;
    const opts = { method: "POST" };
    if (path.endsWith("/action")) opts.body = JSON.stringify({ action });
    const r = await api(path, opts);
    $("#control-out").textContent = JSON.stringify(r, null, 2);
    setTimeout(refreshServers, 500);
  } catch (e) { $("#control-out").textContent = "ERROR: " + e.message; }
});

// Console
$("#console-send").onclick = async () => {
  const cmd = $("#console-cmd").value;
  try {
    const r = await api(`/api/servers/${CURRENT}/console`, {
      method: "POST", body: JSON.stringify({ command: cmd }),
    });
    $("#console-out").textContent = "sent: " + JSON.stringify(r);
    $("#console-cmd").value = "";
  } catch (e) { $("#console-out").textContent = "ERROR: " + e.message; }
};

// Logs
async function loadLogs() {
  const n = $("#log-lines").value || 200;
  try {
    const txt = await api(`/api/servers/${CURRENT}/logs?lines=${encodeURIComponent(n)}`);
    $("#logs-out").textContent = txt;
    $("#logs-out").scrollTop = $("#logs-out").scrollHeight;
  } catch (e) { $("#logs-out").textContent = "ERROR: " + e.message; }
}
$("#refresh-logs").onclick = loadLogs;

// Files
async function listFiles() {
  const area = $("#files-area").value;
  const path = $("#files-path").value || "";
  try {
    const rows = await api(`/api/servers/${CURRENT}/files?area=${encodeURIComponent(area)}&path=${encodeURIComponent(path)}`);
    const tbody = $("#files-table tbody");
    tbody.innerHTML = "";
    if (path) {
      const up = document.createElement("tr");
      up.innerHTML = `<td><a href="#" data-up="1">../</a></td><td></td><td></td><td></td>`;
      tbody.appendChild(up);
    }
    for (const r of rows) {
      const tr = document.createElement("tr");
      const full = (path ? path.replace(/\/$/, "") + "/" : "") + r.name;
      if (r.is_dir) {
        tr.innerHTML = `<td><a href="#" data-into="${escape(full)}">${escape(r.name)}/</a></td>
          <td>-</td><td>${fmtTime(r.mtime)}</td>
          <td><button class="btn btn-tiny btn-danger" data-del="${escape(full)}">delete</button></td>`;
      } else {
        tr.innerHTML = `<td>${escape(r.name)}</td><td>${fmtBytes(r.size)}</td>
          <td>${fmtTime(r.mtime)}</td>
          <td>
            <button class="btn btn-tiny" data-dl="${escape(full)}">download</button>
            <button class="btn btn-tiny btn-danger" data-del="${escape(full)}">delete</button>
          </td>`;
      }
      tbody.appendChild(tr);
    }
  } catch (e) { $("#files-out").textContent = "ERROR: " + e.message; }
}
$("#files-list-btn").onclick = listFiles;
$("#files-area").onchange = () => { $("#files-path").value = ""; listFiles(); };

document.addEventListener("click", async (ev) => {
  const t = ev.target;
  if (t.dataset.into) {
    ev.preventDefault();
    $("#files-path").value = t.dataset.into;
    listFiles();
  } else if (t.dataset.up) {
    ev.preventDefault();
    const cur = $("#files-path").value.replace(/\/$/, "");
    $("#files-path").value = cur.includes("/") ? cur.slice(0, cur.lastIndexOf("/")) : "";
    listFiles();
  } else if (t.dataset.del && CURRENT) {
    if (!confirm(`Delete ${t.dataset.del}?`)) return;
    try {
      const area = $("#files-area").value;
      await api(`/api/servers/${CURRENT}/files?area=${encodeURIComponent(area)}&path=${encodeURIComponent(t.dataset.del)}`, { method: "DELETE" });
      listFiles();
    } catch (e) { alert(e.message); }
  } else if (t.dataset.dl && CURRENT) {
    const area = $("#files-area").value;
    const url = `/api/servers/${CURRENT}/files/download?area=${encodeURIComponent(area)}&path=${encodeURIComponent(t.dataset.dl)}`;
    try {
      const r = await fetch(url, { headers: { "Authorization": "Bearer " + TOKEN } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const blob = await r.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = t.dataset.dl.split("/").pop();
      a.click();
    } catch (e) { alert(e.message); }
  }
});

$("#upload-form")?.addEventListener("submit", () => {}); // legacy, no-op

// ---------- Dropzone / multi-file / folder / archive upload ----------
//
// Three ingress points, all handled the same way:
//   1. drop event (files or a folder)
//   2. #picker-files (multiple files)
//   3. #picker-folder (webkitdirectory — files with webkitRelativePath)
//   4. #picker-archive (single archive; goes to /files/extract if the
//      "extract archives on the server" toggle is on)
//
// The DataTransfer's items expose webkitGetAsEntry() which we walk to
// preserve folder structure when a directory is dropped. Without that,
// dropped folders show up as opaque "directory" entries and the upload
// silently misses their contents.

const ARCHIVE_RE = /\.(zip|tar|tgz|tar\.gz|tbz2|tar\.bz2)$/i;

function isArchiveName(name) { return ARCHIVE_RE.test(String(name || "")); }

function currentUploadArea() { return $("#files-area")?.value || "install"; }
function currentUploadSubdir() { return ($("#upload-path")?.value || "").trim(); }
function shouldOverwrite() { return $("#upload-overwrite")?.checked || false; }
function shouldExtract() { return $("#upload-extract")?.checked !== false; }

function initDropzone() {
  const zone = $("#dropzone");
  if (!zone) return;

  // Wire the pickers (input elements INSIDE labels; the label triggers them).
  $("#picker-files")?.addEventListener("change", (ev) => uploadFileList(ev.target.files));
  $("#picker-folder")?.addEventListener("change", (ev) => uploadFileList(ev.target.files));
  $("#picker-archive")?.addEventListener("change", (ev) => {
    const f = ev.target.files[0];
    if (f) uploadSingle(f, f.name, { forceArchive: true });
  });
  $("#upload-clear")?.addEventListener("click", () => {
    $("#upload-progress-list").innerHTML = "";
    $("#upload-progress").hidden = true;
  });

  // Prevent the browser opening the file when a stray drag lands elsewhere.
  ["dragover", "drop"].forEach(evt =>
    document.addEventListener(evt, e => { if (e.target.closest("#dropzone") == null) { e.preventDefault(); } })
  );

  zone.addEventListener("dragenter", (e) => { e.preventDefault(); zone.classList.add("is-dragover"); });
  zone.addEventListener("dragover",  (e) => { e.preventDefault(); zone.classList.add("is-dragover"); });
  zone.addEventListener("dragleave", (e) => {
    // Only clear if we're leaving the zone entirely, not entering a child.
    if (!zone.contains(e.relatedTarget)) zone.classList.remove("is-dragover");
  });
  zone.addEventListener("drop", async (e) => {
    e.preventDefault();
    zone.classList.remove("is-dragover");

    const items = e.dataTransfer && e.dataTransfer.items;
    if (items && items.length && items[0].webkitGetAsEntry) {
      // Rich path: walk directory entries so we preserve folder structure.
      const entries = [];
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry();
        if (entry) entries.push(entry);
      }
      const collected = [];
      for (const entry of entries) await walkEntry(entry, "", collected);
      await uploadCollected(collected);
    } else if (e.dataTransfer.files) {
      // Fallback: no directory API, treat as flat file list.
      await uploadFileList(e.dataTransfer.files);
    }
  });
}
initDropzone();

async function walkEntry(entry, prefix, collected) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    collected.push({ file, relPath: (prefix ? prefix + "/" : "") + file.name });
  } else if (entry.isDirectory) {
    const dirName = entry.name;
    const reader = entry.createReader();
    // readEntries() returns in batches; loop until it returns an empty array.
    while (true) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) {
        await walkEntry(child, prefix ? `${prefix}/${dirName}` : dirName, collected);
      }
    }
  }
}

async function uploadFileList(fileList) {
  const collected = [];
  for (const f of Array.from(fileList || [])) {
    // Folder picker exposes webkitRelativePath (e.g. "mods/foo.jar").
    const rel = f.webkitRelativePath || f.name;
    collected.push({ file: f, relPath: rel });
  }
  await uploadCollected(collected);
}

async function uploadCollected(items) {
  if (!items.length) return;

  // Single archive + extract mode → route through the extract endpoint,
  // with progress tracked as a single row.
  if (items.length === 1 && shouldExtract() && isArchiveName(items[0].file.name)) {
    showProgress(`Extracting ${items[0].file.name} on server…`);
    const rowId = addProgressRow(items[0].file.name + " (archive)");
    try {
      const r = await uploadOneFile({
        serverName: CURRENT,
        file: items[0].file,
        relPath: items[0].file.name,
        area: currentUploadArea(),
        subdir: currentUploadSubdir(),
        overwrite: shouldOverwrite(),
        extract: true,
        forceArchive: true,
      });
      setRowResult(rowId, "ok", `${r.files_written || 0} files`);
      $("#upload-progress-label").textContent = "Done — archive extracted";
      listFiles();
    } catch (e) {
      setRowResult(rowId, "err", e.message);
    }
    return;
  }

  showProgress(`Uploading ${items.length} file(s)…`);
  let ok = 0, err = 0;
  for (const it of items) {
    const rowId = addProgressRow(it.relPath);
    try {
      await uploadSingle(it.file, it.relPath, { rowId });
      setRowResult(rowId, "ok", "uploaded");
      ok++;
    } catch (e) {
      setRowResult(rowId, "err", e.message);
      err++;
    }
  }
  $("#upload-progress-label").textContent = `Done — ${ok} uploaded, ${err} failed`;
  listFiles();
}

async function uploadSingle(file, relPath, opts = {}) {
  if (!CURRENT) throw new Error("no server selected");
  return uploadOneFile({
    serverName: CURRENT,
    file, relPath,
    area: currentUploadArea(),
    subdir: currentUploadSubdir(),
    overwrite: shouldOverwrite(),
    extract: shouldExtract(),
    forceArchive: !!opts.forceArchive,
    rowId: opts.rowId,
  });
}

// Server-agnostic upload primitive used by both the Files-tab dropzone AND
// the New-Server modal's "initial files" flow. Takes an explicit serverName
// so it doesn't depend on the CURRENT global.
async function uploadOneFile({ serverName, file, relPath, area, subdir,
                                overwrite, extract, forceArchive, rowId }) {
  if (!serverName) throw new Error("uploadOneFile: serverName is required");
  const asArchive = forceArchive || (extract && isArchiveName(file.name));

  const fd = new FormData();
  fd.append("file", file);
  fd.append("area", area || "install");
  fd.append("overwrite", overwrite ? "true" : "false");

  if (asArchive) {
    if (subdir) fd.append("dest_subdir", subdir);
    return await api(`/api/servers/${serverName}/files/extract`, {
      method: "POST", body: fd,
    });
  }

  const dest = subdir ? `${subdir.replace(/\/$/, "")}/${relPath}` : relPath;
  fd.append("path", dest);
  return await api(`/api/servers/${serverName}/files`, {
    method: "POST", body: fd,
  });
}

function showProgress(label) {
  $("#upload-progress").hidden = false;
  $("#upload-progress-label").textContent = label;
}

let _progressSeq = 0;
function addProgressRow(name) {
  const list = $("#upload-progress-list");
  const id = "up-" + (++_progressSeq);
  const li = document.createElement("li");
  li.id = id;
  li.className = "busy";
  li.innerHTML = `
    <span class="upload-progress-name" title="${escape(name)}">${escape(name)}</span>
    <span class="upload-progress-status">…</span>
    <span></span>
  `;
  list.appendChild(li);
  list.scrollTop = list.scrollHeight;
  return id;
}
function setRowResult(id, cls, msg) {
  const li = document.getElementById(id);
  if (!li) return;
  li.className = cls;
  li.querySelector(".upload-progress-status").textContent = msg;
}

// Backups
async function loadBackups() {
  try {
    const rows = await api(`/api/servers/${CURRENT}/backups`);
    const tbody = $("#backups-table tbody");
    tbody.innerHTML = "";
    for (const r of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escape(r.name)}</td><td>${fmtBytes(r.size)}</td><td>${fmtTime(r.mtime)}</td>
        <td><button class="btn btn-tiny" data-restore="${escape(r.name)}">restore</button></td>`;
      tbody.appendChild(tr);
    }
  } catch (e) { $("#backups-out").textContent = "ERROR: " + e.message; }
}
$("#backups-refresh").onclick = loadBackups;
$("#backup-now").onclick = async () => {
  if (!CURRENT) return;
  try {
    const r = await api(`/api/servers/${CURRENT}/backup`, { method: "POST" });
    $("#backups-out").textContent = JSON.stringify(r, null, 2);
    loadBackups();
  } catch (e) { $("#backups-out").textContent = "ERROR: " + e.message; }
};
document.addEventListener("click", async (ev) => {
  const name = ev.target.dataset.restore;
  if (!name || !CURRENT) return;
  if (!confirm(`Restore ${name}? Server must be STOPPED. Existing world will be moved aside.`)) return;
  try {
    const r = await api(`/api/servers/${CURRENT}/restore`, {
      method: "POST", body: JSON.stringify({ backup_name: name }),
    });
    $("#backups-out").textContent = JSON.stringify(r, null, 2);
  } catch (e) { $("#backups-out").textContent = "ERROR: " + e.message; }
});

// Definition
async function loadDef() {
  try {
    const r = await api(`/api/servers/${CURRENT}`);
    $("#def-json").value = JSON.stringify(r.def, null, 2);
  } catch (e) { $("#def-out").textContent = "ERROR: " + e.message; }
}
$("#def-save").onclick = async () => {
  try {
    const sd = JSON.parse($("#def-json").value);
    await api("/api/servers", { method: "POST", body: JSON.stringify(sd) });
    $("#def-out").textContent = "saved";
    refreshServers();
  } catch (e) { $("#def-out").textContent = "ERROR: " + e.message; }
};

// ========================================================================
// NEW SERVER MODAL
// ========================================================================

const TYPE_DEFAULTS = {
  "minecraft-java":  { port: 25565, memory_mb: 4096,  stop_cmd: "stop", java_args: "-XX:+UseG1GC" },
  "minecraft-forge": { port: 25565, memory_mb: 10240, stop_cmd: "stop", java_args: "-XX:+UseG1GC" },
  "steamcmd":        { port: 8211,  memory_mb: 16384, stop_cmd: "",     java_args: "",              steam_app_id: 2394010 },
  "custom":          { port: 27015, memory_mb: 2048,  stop_cmd: "",     java_args: "" },
};

let prevTypeDefaults = null;

// Files queued in the modal for upload right after server creation.
// Each entry: { file, relPath, kind: 'file' | 'folder' | 'archive' }
let initFiles = [];

function openNewServerModal() {
  const modal = $("#modal-backdrop");
  const form = $("#new-server-form");
  form.reset();
  $("#form-error").hidden = true;
  $("#f-auto-start").checked = true;
  prevTypeDefaults = null;
  initFiles = [];
  renderInitFileList();
  applyTypeDefaults($("#f-type").value);
  modal.hidden = false;
  setTimeout(() => $("#f-name").focus(), 30);
}
function closeNewServerModal() { $("#modal-backdrop").hidden = true; }

// ---------- initial-files staging inside the New Server modal ----------

function initFilePickers() {
  $("#init-picker-files")?.addEventListener("change", (ev) => {
    for (const f of Array.from(ev.target.files || [])) {
      initFiles.push({ file: f, relPath: f.name, kind: "file" });
    }
    ev.target.value = "";
    renderInitFileList();
  });
  $("#init-picker-folder")?.addEventListener("change", (ev) => {
    for (const f of Array.from(ev.target.files || [])) {
      initFiles.push({
        file: f,
        relPath: f.webkitRelativePath || f.name,
        kind: "folder",
      });
    }
    ev.target.value = "";
    renderInitFileList();
  });
  $("#init-picker-archive")?.addEventListener("change", (ev) => {
    const f = ev.target.files[0];
    if (f) initFiles.push({ file: f, relPath: f.name, kind: "archive" });
    ev.target.value = "";
    renderInitFileList();
  });
}
initFilePickers();

function renderInitFileList() {
  const list = $("#init-file-list");
  const summary = $("#init-file-summary");
  if (!list) return;
  list.innerHTML = "";
  if (!initFiles.length) {
    summary.hidden = true;
    return;
  }
  let totalBytes = 0;
  initFiles.forEach((it, idx) => {
    totalBytes += it.file.size || 0;
    const li = document.createElement("li");
    li.dataset.idx = idx;
    li.innerHTML = `
      <span class="init-kind">${it.kind}</span>
      <span class="init-name" title="${escape(it.relPath)}">${escape(it.relPath)}</span>
      <span class="init-status muted">${fmtBytes(it.file.size)}</span>
      <button type="button" class="init-remove" data-init-remove="${idx}" title="Remove">&times;</button>
    `;
    list.appendChild(li);
  });
  summary.hidden = false;
  summary.textContent = `${initFiles.length} file(s) queued · ${fmtBytes(totalBytes)} total`;
}

// One delegated handler for both "×" clicks in the list.
$("#init-file-list")?.addEventListener("click", (ev) => {
  const idx = ev.target.dataset.initRemove;
  if (idx == null) return;
  initFiles.splice(parseInt(idx, 10), 1);
  renderInitFileList();
});

$("#modal-close").onclick = closeNewServerModal;
$("#modal-cancel").onclick = closeNewServerModal;
$("#modal-backdrop").addEventListener("click", (ev) => {
  if (ev.target.id === "modal-backdrop") closeNewServerModal();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !$("#modal-backdrop").hidden) closeNewServerModal();
});

function applyTypeDefaults(type) {
  const d = TYPE_DEFAULTS[type] || {};
  $("#fs-steamcmd").hidden = type !== "steamcmd";
  $("#fs-forge").hidden    = type !== "minecraft-forge";

  const setIfDefault = (id, key, formatter = (v) => v) => {
    const el = document.getElementById(id);
    if (!el) return;
    const cur = el.value;
    const prev = prevTypeDefaults ? formatter(prevTypeDefaults[key] ?? "") : "";
    if (cur === "" || cur === prev) el.value = formatter(d[key] ?? "");
  };
  setIfDefault("f-port", "port", String);
  setIfDefault("f-memory", "memory_mb", String);
  setIfDefault("f-stop-cmd", "stop_cmd");
  setIfDefault("f-java-args", "java_args");
  if (type === "steamcmd") setIfDefault("f-steam-app-id", "steam_app_id", String);

  syncPathsFromName();
  prevTypeDefaults = d;
}
$("#f-type").addEventListener("change", (ev) => applyTypeDefaults(ev.target.value));

function syncPathsFromName() {
  const name = ($("#f-name").value || "").trim();
  const inst = $("#f-install-dir");
  const world = $("#f-world-dir");
  const nameFor = (base) => name ? `${base}/${name}` : "";
  const looksDerived = (val) =>
    !val || /^\/(srv\/gameservers|opt\/gamesrv\/worlds)\/[a-z0-9-]+$/.test(val);
  if (looksDerived(inst.value))  inst.value  = nameFor("/srv/gameservers");
  if (looksDerived(world.value)) world.value = nameFor("/opt/gamesrv/worlds");
}
$("#f-name").addEventListener("input", syncPathsFromName);

$("#new-server-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  $("#form-error").hidden = true;

  const type = $("#f-type").value;
  const sd = {
    name:               $("#f-name").value.trim(),
    type:               type,
    install_dir:        $("#f-install-dir").value.trim(),
    world_dir:          $("#f-world-dir").value.trim(),
    port:               parseInt($("#f-port").value, 10),
    memory_mb:          parseInt($("#f-memory").value, 10),
    java_args:          $("#f-java-args").value,
    stop_cmd:           $("#f-stop-cmd").value,
    auto_start_on_boot: $("#f-auto-start").checked,
  };
  if (type === "steamcmd") {
    const appId = parseInt($("#f-steam-app-id").value, 10);
    if (!appId) { showFormError("steamcmd type needs a Steam App ID"); return; }
    sd.steam_app_id = appId;
    const beta = $("#f-steam-beta").value.trim();
    if (beta) sd.steam_beta = beta;
  }
  if (type === "minecraft-forge") {
    const mcv = $("#f-mc-version").value.trim();
    const fv  = $("#f-forge-version").value.trim();
    if (mcv) sd.mc_version = mcv;
    if (fv)  sd.forge_version = fv;
  }
  const rconEnabled = $("#f-rcon-enabled").checked;
  const rconPort    = $("#f-rcon-port").value.trim();
  const rconPwEnv   = $("#f-rcon-pw-env").value.trim();
  if (rconEnabled || rconPort || rconPwEnv) {
    sd.rcon = { enabled: rconEnabled };
    if (rconPort)  sd.rcon.port = parseInt(rconPort, 10);
    if (rconPwEnv) sd.rcon.password_env = rconPwEnv;
  }

  try {
    await api("/api/servers", { method: "POST", body: JSON.stringify(sd) });
  } catch (e) {
    showFormError("Create failed: " + e.message);
    return;
  }

  // Server def is on disk. Kick off any queued initial-file uploads before
  // closing the modal so the user can watch them succeed/fail here rather
  // than on the detail panel.
  if (initFiles.length) {
    const saveBtn = $("#modal-save");
    saveBtn.disabled = true;
    saveBtn.textContent = `Uploading 0 / ${initFiles.length}…`;

    const area   = $("#init-upload-area").value || "install";
    const subdir = ($("#init-upload-path").value || "").trim();

    let ok = 0, err = 0;
    for (let i = 0; i < initFiles.length; i++) {
      const it = initFiles[i];
      const li = $("#init-file-list").querySelector(`li[data-idx="${i}"]`);
      if (li) { li.className = "busy"; li.querySelector(".init-status").textContent = "uploading…"; }
      try {
        const r = await uploadOneFile({
          serverName: sd.name,
          file: it.file,
          relPath: it.relPath,
          area, subdir,
          overwrite: false,
          extract: it.kind === "archive",   // only extract explicit archive picks
          forceArchive: it.kind === "archive",
        });
        if (li) {
          li.className = "ok";
          li.querySelector(".init-status").textContent =
            it.kind === "archive" ? `${r.files_written || 0} files` : "ok";
        }
        ok++;
      } catch (e) {
        if (li) {
          li.className = "err";
          li.querySelector(".init-status").textContent = e.message;
        }
        err++;
      }
      saveBtn.textContent = `Uploading ${i + 1} / ${initFiles.length}…`;
    }

    saveBtn.disabled = false;
    saveBtn.textContent = "Create Server";

    if (err) {
      // Leave the modal open so the user can see what failed and decide
      // whether to close manually or retry from the Files tab.
      showFormError(
        `Server created, but ${err} upload(s) failed. Fix and use the Files ` +
        `tab, or click Cancel to close.`
      );
      await refreshServers();
      return;
    }
  }

  closeNewServerModal();
  await refreshServers();
  openServer(sd.name);
});

function showFormError(msg) {
  const el = $("#form-error");
  el.textContent = msg;
  el.hidden = false;
}

// ========================================================================
// INIT
// ========================================================================

refreshAuthBadge();
showPage(TOKEN ? "dashboard" : "admin");
