// Minimal dashboard JS. Token stored in localStorage; sent as Bearer on every /api call.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let TOKEN = localStorage.getItem("gamesrv_token") || "";
let CURRENT = null; // currently open server name

function setTokenStatus(msg, ok) {
  const el = $("#token-status");
  el.textContent = msg;
  el.style.color = ok ? "var(--ok)" : "var(--muted)";
}

if (TOKEN) { $("#token").value = TOKEN; setTokenStatus("token loaded", true); }

$("#save-token").onclick = () => {
  TOKEN = $("#token").value.trim();
  localStorage.setItem("gamesrv_token", TOKEN);
  setTokenStatus("token saved", true);
  refreshServers();
};

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

// ---------- servers list ----------

async function refreshServers() {
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
    alert("List failed: " + e.message);
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

// ---------- new server (uses a simple prompt for MVP) ----------

$("#new-server").onclick = async () => {
  const example = {
    name: "myserver",
    type: "minecraft-java",
    install_dir: "/srv/gameservers/myserver",
    world_dir: "/opt/gamesrv/worlds/myserver",
    port: 25565,
    memory_mb: 4096,
    java_args: "-XX:+UseG1GC",
    stop_cmd: "stop",
    auto_start_on_boot: true,
  };
  const raw = prompt("Paste server definition JSON:", JSON.stringify(example, null, 2));
  if (!raw) return;
  try {
    const sd = JSON.parse(raw);
    await api("/api/servers", { method: "POST", body: JSON.stringify(sd) });
    refreshServers();
  } catch (e) { alert(e.message); }
};

// ---------- detail panel ----------

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
    // Auth via header is fine, but download tags don't send headers; use blob path.
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

// Manager self-update
$("#manager-update").onclick = async () => {
  if (!confirm("Pull latest from GitHub and restart the manager? The UI may drop for ~10s.")) return;
  try {
    const r = await api("/api/manager/update", { method: "POST" });
    alert("Triggered. Check the Logs tail: " + JSON.stringify(r));
  } catch (e) { alert(e.message); }
};

// initial load
refreshServers();
setInterval(refreshServers, 5000);
