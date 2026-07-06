// Minimal dashboard JS. Token stored in localStorage; sent as Bearer on every /api call.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let TOKEN = localStorage.getItem("gamesrv_token") || "";
let CURRENT = null;              // currently open server name
let CURRENT_PAGE = "dashboard";  // dashboard | admin
let SERVERS_TIMER = null;
let UPDATE_LOG_TIMER = null;

// ---------- auth badge (shown in the top nav) ----------

function refreshAuthBadge() {
  const el = $("#auth-badge");
  if (!el) return;
  if (TOKEN) {
    el.textContent = "token loaded";
    el.className = "muted ok";
  } else {
    el.textContent = "no token — set on Admin page";
    el.className = "muted warn";
  }
}

// ---------- page switching ----------

function showPage(name) {
  CURRENT_PAGE = name;
  $$(".page").forEach(p => p.hidden = p.id !== `page-${name}`);
  $$(".nav").forEach(b => b.classList.toggle("active", b.dataset.page === name));

  // Enable/disable polling per page.
  clearInterval(SERVERS_TIMER); SERVERS_TIMER = null;
  clearInterval(UPDATE_LOG_TIMER); UPDATE_LOG_TIMER = null;

  if (name === "dashboard") {
    refreshServers();
    SERVERS_TIMER = setInterval(refreshServers, 5000);
  } else if (name === "admin") {
    // Prefill the token box (masked) so the user can see something is saved.
    $("#token").value = TOKEN;
    // If follow-log is already ticked, resume polling.
    if ($("#follow-update-log").checked) startFollowUpdateLog();
  }
}

$$(".nav").forEach(b => b.onclick = () => showPage(b.dataset.page));

// ---------- API helper ----------

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
function fmtTime(ts) {
  if (!ts) return "-";
  return new Date(ts * 1000).toLocaleString();
}

// ========================================================================
// ADMIN PAGE
// ========================================================================

$("#save-token").onclick = () => {
  TOKEN = $("#token").value.trim();
  localStorage.setItem("gamesrv_token", TOKEN);
  refreshAuthBadge();
  $("#token-status").textContent = "saved";
  $("#token-status").className = "muted ok";
};

$("#clear-token").onclick = () => {
  TOKEN = "";
  localStorage.removeItem("gamesrv_token");
  $("#token").value = "";
  refreshAuthBadge();
  $("#token-status").textContent = "cleared";
  $("#token-status").className = "muted";
};

$("#test-token").onclick = async () => {
  try {
    // Any authenticated endpoint will do; /api/servers is the cheapest.
    const rows = await api("/api/servers");
    $("#token-status").textContent = `ok — ${rows.length} server(s) registered`;
    $("#token-status").className = "muted ok";
  } catch (e) {
    $("#token-status").textContent = "FAIL: " + e.message;
    $("#token-status").className = "muted err";
  }
};

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
    // Auto-follow while an update is in flight so the user actually sees it.
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
    // /healthz is unauthenticated so it works even without a token.
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
// DASHBOARD PAGE
// ========================================================================

async function refreshServers() {
  if (!TOKEN) return;  // silently skip — Admin page will nag the user.
  try {
    const rows = await api("/api/servers");
    const tbody = $("#servers tbody");
    tbody.innerHTML = "";
    for (const r of rows) {
      const d = r.def, s = r.status;
      const tr = document.createElement("tr");
      tr.dataset.active = s.active;
      tr.innerHTML = `
        <td><a href="#" data-open="${d.name}">${d.name}</a></td>
        <td>${d.type}</td>
        <td class="state">${s.active}/${s.sub}</td>
        <td>${d.port}</td>
        <td>${fmtBytes(s.mem_bytes)} / ${d.memory_mb} MB cap</td>
        <td>${fmtDur(s.uptime_sec)}</td>
        <td>
          <button data-quick="start" data-name="${d.name}">▶</button>
          <button data-quick="stop" data-name="${d.name}">■</button>
          <button data-quick="restart" data-name="${d.name}">↻</button>
        </td>`;
      tbody.appendChild(tr);
    }
  } catch (e) {
    // Don't spam alerts on background poll — surface via auth badge.
    const badge = $("#auth-badge");
    if (badge) {
      badge.textContent = "auth error — check Admin page";
      badge.className = "muted err";
    }
  }
}

document.addEventListener("click", async (ev) => {
  const t = ev.target;
  if (t.dataset.open) { ev.preventDefault(); openServer(t.dataset.open); return; }
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

$("#new-server").onclick = () => openNewServerModal();

// ---------- New-Server modal ----------
//
// Type-aware defaults keep the form usable without the user having to memorize
// ports and app IDs. If a field's value is empty OR equal to the previous
// type's default, we overwrite it when the type changes; if the user typed
// something custom, we leave it alone.

const TYPE_DEFAULTS = {
  "minecraft-java":  { port: 25565, memory_mb: 4096,  stop_cmd: "stop", java_args: "-XX:+UseG1GC" },
  "minecraft-forge": { port: 25565, memory_mb: 10240, stop_cmd: "stop", java_args: "-XX:+UseG1GC" },
  "steamcmd":        { port: 8211,  memory_mb: 16384, stop_cmd: "",     java_args: "",              steam_app_id: 2394010 },
  "custom":          { port: 27015, memory_mb: 2048,  stop_cmd: "",     java_args: "" },
};

let prevTypeDefaults = null;   // for detecting "user hasn't customized this field"

function openNewServerModal() {
  const modal = $("#modal-backdrop");
  const form = $("#new-server-form");
  form.reset();
  $("#form-error").hidden = true;
  $("#f-auto-start").checked = true;
  prevTypeDefaults = null;
  applyTypeDefaults($("#f-type").value);
  modal.hidden = false;
  setTimeout(() => $("#f-name").focus(), 30);
}
function closeNewServerModal() { $("#modal-backdrop").hidden = true; }

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

  // Show/hide type-specific fieldsets.
  $("#fs-steamcmd").hidden = type !== "steamcmd";
  $("#fs-forge").hidden    = type !== "minecraft-forge";

  // For each defaulted field: replace value only if empty or unchanged from
  // the previous type's default (i.e. the user hasn't typed anything custom).
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
  if (type === "steamcmd") {
    setIfDefault("f-steam-app-id", "steam_app_id", String);
  }

  syncPathsFromName();
  prevTypeDefaults = d;
}

$("#f-type").addEventListener("change", (ev) => applyTypeDefaults(ev.target.value));

// Auto-derive install_dir / world_dir from the name unless the user typed a
// custom value into either box.
function syncPathsFromName() {
  const name = ($("#f-name").value || "").trim();
  const inst = $("#f-install-dir");
  const world = $("#f-world-dir");
  const nameFor = (base) => name ? `${base}/${name}` : "";

  // Only rewrite if empty or if it still matches a name-derived path pattern.
  const looksDerived = (val, base) =>
    !val || /^\/(srv\/gameservers|opt\/gamesrv\/worlds)\/[a-z0-9-]+$/.test(val);

  if (looksDerived(inst.value, "/srv/gameservers")) {
    inst.value = nameFor("/srv/gameservers");
  }
  if (looksDerived(world.value, "/opt/gamesrv/worlds")) {
    world.value = nameFor("/opt/gamesrv/worlds");
  }
}
$("#f-name").addEventListener("input", syncPathsFromName);

// Build the ServerDef JSON from the form and POST it.
$("#new-server-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const errEl = $("#form-error");
  errEl.hidden = true;

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

  // Type-specific extras.
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

  // RCON block (only sent if enabled OR the user filled anything in).
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
    closeNewServerModal();
    await refreshServers();
    // Auto-open the new server so the user can go straight to Install.
    openServer(sd.name);
  } catch (e) {
    showFormError(e.message);
  }
});

function showFormError(msg) {
  const el = $("#form-error");
  el.textContent = msg;
  el.hidden = false;
}

async function openServer(name) {
  CURRENT = name;
  $("#detail-panel").hidden = false;
  $("#detail-title").textContent = name;
  showTab("control");
}

function showTab(name) {
  $$(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab-body").forEach(b => b.hidden = b.dataset.body !== name);
  if (name === "logs") loadLogs();
  if (name === "files") listFiles();
  if (name === "backups") loadBackups();
  if (name === "def") loadDef();
}
$$(".tab").forEach(b => b.onclick = () => showTab(b.dataset.tab));

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

// Console tab
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

// Logs tab
async function loadLogs() {
  const n = $("#log-lines").value || 200;
  try {
    const txt = await api(`/api/servers/${CURRENT}/logs?lines=${encodeURIComponent(n)}`);
    $("#logs-out").textContent = txt;
    $("#logs-out").scrollTop = $("#logs-out").scrollHeight;
  } catch (e) { $("#logs-out").textContent = "ERROR: " + e.message; }
}
$("#refresh-logs").onclick = loadLogs;

// Files tab
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
        tr.innerHTML = `<td><a href="#" data-into="${full}">${r.name}/</a></td>
          <td>-</td><td>${fmtTime(r.mtime)}</td>
          <td><button data-del="${full}">delete</button></td>`;
      } else {
        tr.innerHTML = `<td>${r.name}</td><td>${fmtBytes(r.size)}</td>
          <td>${fmtTime(r.mtime)}</td>
          <td><button data-dl="${full}">download</button>
              <button data-del="${full}">delete</button></td>`;
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
    // Auth via header is fine, but <a download> tags don't send headers; use blob path.
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

$("#upload-form").onsubmit = async (ev) => {
  ev.preventDefault();
  const file = $("#upload-file").files[0];
  if (!file || !CURRENT) return;
  const fd = new FormData();
  fd.append("file", file);
  fd.append("area", $("#files-area").value);
  fd.append("path", $("#upload-path").value || file.name);
  fd.append("overwrite", $("#upload-overwrite").checked ? "true" : "false");
  try {
    const r = await api(`/api/servers/${CURRENT}/files`, { method: "POST", body: fd });
    $("#files-out").textContent = JSON.stringify(r, null, 2);
    listFiles();
  } catch (e) { $("#files-out").textContent = "ERROR: " + e.message; }
};

// Backups
async function loadBackups() {
  try {
    const rows = await api(`/api/servers/${CURRENT}/backups`);
    const tbody = $("#backups-table tbody");
    tbody.innerHTML = "";
    for (const r of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${r.name}</td><td>${fmtBytes(r.size)}</td><td>${fmtTime(r.mtime)}</td>
        <td><button data-restore="${r.name}">restore</button></td>`;
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

// Definition tab
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
// INITIAL LOAD
// ========================================================================

refreshAuthBadge();
// If the user has no token yet, land on Admin so they can paste one.
showPage(TOKEN ? "dashboard" : "admin");
