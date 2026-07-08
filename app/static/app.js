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
    if (TOKEN) {
      // Only load these if we have a token — otherwise the calls 401 loudly.
      loadRuntimeInfo();
      loadEnvEditor();
    }
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
  // Load runtime + env if we're on the Admin page.
  if (CURRENT_PAGE === "admin") {
    loadRuntimeInfo();
    loadEnvEditor();
  }
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
    // Preserve scroll-at-bottom "tail" behaviour so scrolling up to inspect
    // an earlier run doesn't get yanked back down by the follow-timer.
    const wasAtBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
    pre.textContent = txt || "(update.log is empty)";
    if (wasAtBottom) pre.scrollTop = pre.scrollHeight;
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

// ---------- Runtime widget ----------

async function loadRuntimeInfo() {
  try {
    const r = await api("/api/manager/info");
    $("#rt-repo").textContent   = r.repo_dir || "-";
    $("#rt-python").textContent = r.python_exe || "-";
    $("#rt-python-ver").textContent = r.python_ver ? `(${r.python_ver})` : "";
    $("#rt-branch").textContent = r.git_branch || "-";
    $("#rt-head").textContent   = r.git_head || "-";
    $("#rt-last").textContent   = r.git_last || "-";
    $("#rt-unit").textContent   = r.unit || "-";
    $("#rt-updater").textContent = r.updater_unit || "-";
    $("#rt-env").textContent    = r.env_file || "-";
    $("#runtime-branch").textContent = r.git_branch
      ? `${r.git_branch} · ${r.git_head || ""}` : "no git";
    $("#admin-envfile-path").textContent = r.env_file || "/etc/gamesrv.env";
  } catch (e) {
    // If we can't reach /api yet (no token), silently skip.
  }
}
$("#runtime-refresh")?.addEventListener("click", loadRuntimeInfo);

// ---------- Restart button ----------

$("#manager-restart")?.addEventListener("click", async () => {
  if (!confirm(
    "Restart the manager now?\n\n" +
    "This bounces the process WITHOUT pulling new code. Useful after " +
    "editing environment values. Game servers are unaffected — they " +
    "run under their own systemd units."
  )) return;
  try {
    const r = await api("/api/manager/restart", { method: "POST" });
    $("#update-log-out").textContent =
      "restart requested: " + JSON.stringify(r, null, 2) +
      "\n\n(waiting for the manager to come back...)\n";
    // Poll /healthz until it answers again.
    const deadline = Date.now() + 30_000;
    const poll = async () => {
      if (Date.now() > deadline) {
        $("#update-log-out").textContent += "\nTIMEOUT waiting for /healthz.\n";
        return;
      }
      try {
        const hr = await fetch("/healthz");
        if (hr.ok) {
          $("#update-log-out").textContent += "\nmanager is back up.\n";
          await loadRuntimeInfo();
          return;
        }
      } catch (_e) { /* keep polling */ }
      setTimeout(poll, 500);
    };
    setTimeout(poll, 1000);
  } catch (e) {
    alert("Restart trigger failed: " + e.message);
  }
});

// ---------- Env editor ----------

let ENV_CACHE = null;   // last /api/manager/env response

async function loadEnvEditor() {
  try {
    const r = await api("/api/manager/env");
    ENV_CACHE = r;
    $("#env-path-chip").textContent = r.path || "-";

    const warn = $("#env-writable-warn");
    if (r.writable) {
      warn.hidden = true;
    } else {
      warn.hidden = false;
      warn.textContent = "Env file is not writable — Save will fail.\n" + (r.writable_reason || "");
    }

    // Group managed keys by section.
    const bySection = {};
    for (const k of r.known || []) {
      (bySection[k.section] = bySection[k.section] || []).push(k);
    }

    const form = $("#env-form");
    form.innerHTML = "";
    for (const section of Object.keys(bySection)) {
      const fs = document.createElement("fieldset");
      fs.className = "env-section";
      fs.innerHTML = `<legend>${escape(section)}</legend>`;
      for (const k of bySection[section]) {
        fs.appendChild(renderEnvRow(k, /*extra=*/false));
      }
      form.appendChild(fs);
    }

    // Always render an Extras fieldset (with existing rows if any) plus an
    // "Add key" input at the bottom so new per-server PATs / RCON passwords
    // can be created from the UI, not just edited.
    const fs = document.createElement("fieldset");
    fs.className = "env-section";
    fs.innerHTML = `<legend>Extras (per-server secrets etc.)</legend>`;
    for (const k of (r.extras || [])) fs.appendChild(renderEnvRow(k, /*extra=*/true));
    fs.appendChild(renderAddKeyRow());
    form.appendChild(fs);
  } catch (e) {
    $("#env-status").textContent = "LOAD FAIL: " + e.message;
    $("#env-status").className = "muted err";
  }
}

// A row of one input + Add button. Typing a name and clicking Add creates
// a new blank Extras row in the current form (secret if the name ends with
// _PW/_PASSWORD/_TOKEN/_PAT/_SECRET/_KEY). The row is NOT saved to disk
// until the user hits Save / Save & Restart.
function renderAddKeyRow() {
  const row = document.createElement("div");
  row.className = "env-row";
  row.innerHTML = `
    <label>
      <div><strong>Add key</strong></div>
      <div class="muted" style="font-size:11px;">
        UPPERCASE_WITH_UNDERSCORES. Must match one of:
        <code>MC_*</code>, <code>PALWORLD_*</code>, <code>VALHEIM_*</code>,
        <code>ARK_*</code>, <code>GAMESRV_*</code>, <code>SERVER_*</code>.
      </div>
    </label>
    <div class="env-value-group">
      <input id="env-add-key" placeholder="e.g. MC_MODDED_DPR_GIT_PAT" autocomplete="off"
             style="text-transform: uppercase;" />
      <button type="button" class="btn btn-tiny" id="env-add-btn">Add</button>
    </div>
    <p class="env-help" id="env-add-help"></p>
  `;
  // Wire the button after the DOM is attached — event delegation below
  // hooks the click as long as the id exists in the current form.
  return row;
}

// Delegated Add handler (survives re-renders).
const _EXTRA_KEY_PATTERNS = [
  /^MC_[A-Z0-9_]+$/,
  /^PALWORLD_[A-Z0-9_]+$/,
  /^VALHEIM_[A-Z0-9_]+$/,
  /^ARK_[A-Z0-9_]+$/,
  /^GAMESRV_[A-Z0-9_]+$/,
  /^SERVER_[A-Z0-9_]+$/,
];
const _SECRET_SUFFIXES = ["_PW", "_PASSWORD", "_TOKEN", "_PAT", "_SECRET", "_KEY"];

document.addEventListener("click", (ev) => {
  if (ev.target.id !== "env-add-btn") return;
  const input = document.getElementById("env-add-key");
  const help  = document.getElementById("env-add-help");
  const name  = (input.value || "").trim().toUpperCase();
  help.textContent = "";
  if (!name) return;
  if (!_EXTRA_KEY_PATTERNS.some(p => p.test(name))) {
    help.textContent = `"${name}" doesn't match any writable pattern — the server would reject it.`;
    help.style.color = "var(--danger)";
    return;
  }
  // Refuse if it already exists somewhere in the form.
  if (document.querySelector(`.env-row[data-name="${CSS.escape(name)}"]`)) {
    help.textContent = `${name} is already in the form. Edit that row instead.`;
    help.style.color = "var(--warn)";
    return;
  }
  const isSecret = _SECRET_SUFFIXES.some(s => name.endsWith(s));
  const row = renderEnvRow({
    name, value: "", is_secret: isSecret, writable: true,
  }, /*extra=*/true);
  // Insert the new row ABOVE the Add-key row so the Add-key row stays last.
  const addRow = input.closest(".env-row");
  addRow.parentNode.insertBefore(row, addRow);
  input.value = "";
  help.textContent = `${name} added — paste the value and click Save.`;
  help.style.color = "var(--success)";
  // Focus the new row's input for immediate typing.
  row.querySelector("input")?.focus();
});

function renderEnvRow(k, extra) {
  const row = document.createElement("div");
  row.className = "env-row" + ((extra && !k.writable) ? " readonly" : "");
  row.dataset.name = k.name;
  row.dataset.secret = k.is_secret ? "1" : "0";

  const inputType = k.is_secret ? "password" : (k.input_type || "text");
  const label = extra ? k.name : (k.label || k.name);
  const help = extra
    ? (k.writable ? "" : "read-only — this key isn't managed here")
    : (k.help || "");
  const placeholder = k.is_secret
    ? (k.value ? "(blank = keep current value)" : "(not set)")
    : "";
  // For secrets, we DO NOT pre-fill the field. Blank on save means "keep".
  const initialValue = k.is_secret ? "" : (k.value || "");

  row.innerHTML = `
    <label>
      <div><code>${escape(k.name)}</code></div>
      <div class="muted" style="font-size:11px;">${escape(label)}</div>
    </label>
    <div class="env-value-group">
      <input
        name="${escape(k.name)}"
        type="${inputType}"
        value="${escape(initialValue)}"
        placeholder="${escape(placeholder)}"
        autocomplete="off"
        ${extra && !k.writable ? "disabled" : ""}
      />
      ${k.is_secret ? `<button type="button" class="env-reveal" data-env-reveal title="Show / hide">👁</button>` : ""}
    </div>
    <p class="env-help">${escape(help)}</p>
  `;
  return row;
}

// Toggle password visibility for secret rows.
document.addEventListener("click", (ev) => {
  if (!ev.target.dataset || ev.target.dataset.envReveal === undefined) return;
  const row = ev.target.closest(".env-row");
  const input = row.querySelector("input");
  input.type = input.type === "password" ? "text" : "password";
});

$("#env-reload")?.addEventListener("click", loadEnvEditor);

// Actual save call. Returns the API response so the caller can chain
// (e.g. Save & Restart). Sets the visible status line either way.
async function saveEnvOnce() {
  const rows = $$(".env-row");
  const updates = {};
  for (const row of rows) {
    const input = row.querySelector("input");
    if (!input || input.disabled) continue;
    // For secrets: blank means "keep current" — server-side logic handles it.
    updates[row.dataset.name] = input.value;
  }
  const r = await api("/api/manager/env", {
    method: "POST", body: JSON.stringify({ updates }),
  });
  const parts = [];
  if (r.changed?.length) parts.push(`saved: ${r.changed.join(", ")}`);
  if (r.unchanged_secrets?.length) parts.push(`kept secrets: ${r.unchanged_secrets.join(", ")}`);
  if (r.rejected?.length) parts.push(`REJECTED: ${r.rejected.join(", ")}`);
  if (!parts.length) parts.push("no changes");
  $("#env-status").textContent = parts.join(" · ");
  $("#env-status").className = "muted ok";
  return r;
}

$("#env-save")?.addEventListener("click", async () => {
  try {
    const r = await saveEnvOnce();
    if (r.changed?.length) {
      $("#env-status").textContent = $("#env-status").textContent +
        " · click Restart in Manager Self-Update (env only re-reads at startup).";
    }
    await loadEnvEditor();
  } catch (e) {
    $("#env-status").textContent = "SAVE FAIL: " + e.message;
    $("#env-status").className = "muted err";
  }
});

$("#env-save-and-restart")?.addEventListener("click", async () => {
  let r;
  try {
    r = await saveEnvOnce();
  } catch (e) {
    $("#env-status").textContent = "SAVE FAIL: " + e.message;
    $("#env-status").className = "muted err";
    return;
  }

  // If nothing actually changed, don't bounce the manager unnecessarily.
  if (!r.changed?.length) {
    $("#env-status").textContent = "no changes — skipped restart";
    return;
  }

  if (!confirm(
    "Save succeeded. Restart the manager now so the new env values take effect?\n\n" +
    "The UI will drop for ~2 s while systemd bounces the service. " +
    "Game servers are unaffected — they run under their own units."
  )) return;

  try {
    await api("/api/manager/restart", { method: "POST" });
    $("#env-status").textContent = "restart triggered — waiting for manager…";
    $("#env-status").className = "muted";
    // Poll /healthz until it answers again.
    const deadline = Date.now() + 30_000;
    const poll = async () => {
      if (Date.now() > deadline) {
        $("#env-status").textContent = "TIMEOUT waiting for /healthz — check journal";
        $("#env-status").className = "muted err";
        return;
      }
      try {
        const hr = await fetch("/healthz");
        if (hr.ok) {
          $("#env-status").textContent = "manager restarted — new env is live";
          $("#env-status").className = "muted ok";
          await loadEnvEditor();
          await loadRuntimeInfo();
          return;
        }
      } catch (_e) { /* keep polling */ }
      setTimeout(poll, 500);
    };
    setTimeout(poll, 1000);
  } catch (e) {
    $("#env-status").textContent = "RESTART FAIL: " + e.message;
    $("#env-status").className = "muted err";
  }
});

// ========================================================================
// DASHBOARD — server cards
// ========================================================================

async function refreshServers() {
  if (!TOKEN) return;
  try {
    // Aggregate stats + per-server list share the same refresh tick so the
    // header stays in sync with the cards below.
    const [rows, stats] = await Promise.all([
      api("/api/servers"),
      api("/api/stats").catch(() => null),   // stats is best-effort — don't break the whole tick
    ]);
    renderServerGrid(rows);
    updatePerfHistory(rows);
    if (stats) renderStatsBar(stats);
    const badge = $("#auth-badge");
    if (badge && badge.classList.contains("err")) { badge.textContent = "token loaded"; badge.className = "ok"; }
  } catch (e) {
    const badge = $("#auth-badge");
    if (badge) { badge.textContent = "auth error — check Admin page"; badge.className = "err"; }
  }
}

// ---------- Aggregate dashboard stats ----------
// Populated from /api/stats. Everything is best-effort: if the endpoint
// hasn't shipped on the server yet, we simply keep the bar hidden.

function renderStatsBar(stats) {
  const bar = $("#stats-bar");
  if (!bar) return;
  bar.hidden = false;

  const s = stats.servers || {};
  $("#stat-servers").textContent = `${s.running || 0} / ${s.total || 0}`;
  const bits = [];
  if (s.failed)  bits.push(`${s.failed} failed`);
  if (s.stopped) bits.push(`${s.stopped} stopped`);
  $("#stat-servers-sub").textContent = bits.join(" · ") || "all healthy";

  const ram = stats.ram || {};
  const ramPct = Number(ram.percent) || 0;
  $("#stat-ram").textContent = fmtBytes(ram.used_bytes || 0);
  $("#stat-ram-fill").style.width = Math.min(100, ramPct).toFixed(1) + "%";
  setBarClass($("#stat-ram-fill"), ramPct);
  const cap = ram.limit_bytes ? ` / ${fmtBytes(ram.limit_bytes)}` : "";
  const reserved = ram.reserved_bytes
    ? ` · ${fmtBytes(ram.reserved_bytes)} reserved`
    : "";
  $("#stat-ram-sub").textContent = `${ramPct.toFixed(1)}%${cap}${reserved}`;

  renderDiskStat("worlds",  (stats.disk || {}).worlds_root);
  renderDiskStat("install", (stats.disk || {}).install_root);

  const up = (stats.manager || {}).uptime_sec;
  $("#stat-uptime").textContent = up != null ? fmtDur(up) : "—";
}

function renderDiskStat(key, d) {
  if (!d) {
    $(`#stat-${key}`).textContent = "—";
    $(`#stat-${key}-fill`).style.width = "0%";
    $(`#stat-${key}-sub`).textContent = "unavailable";
    return;
  }
  const pct = d.total ? (100 * d.used / d.total) : 0;
  $(`#stat-${key}`).textContent = fmtBytes(d.used);
  $(`#stat-${key}-fill`).style.width = Math.min(100, pct).toFixed(1) + "%";
  setBarClass($(`#stat-${key}-fill`), pct);
  $(`#stat-${key}-sub`).textContent = `${pct.toFixed(1)}% of ${fmtBytes(d.total)}`;
}

function setBarClass(el, pct) {
  el.classList.remove("ok", "warn", "err");
  if (pct >= 90) el.classList.add("err");
  else if (pct >= 75) el.classList.add("warn");
}

// ---------- Perf history + sparklines ----------
//
// Per-server ring buffer keyed by name. Each entry:
//   { t_ms, active, mem_bytes, cpu_usec, uptime_sec, mem_pct, cpu_pct }
// CPU% = 100 * (Δcpu_usec / 1000 / Δt_ms). systemd reports cpu_usec in
// nanoseconds (property CPUUsageNSec), which control.py forwards as-is.

const PERF_HISTORY = new Map();
const PERF_MAX = 30;   // ~2.5 min at 5s poll interval

function updatePerfHistory(rows) {
  const now = Date.now();
  for (const r of rows) {
    const name = r.def.name;
    const capBytes = (r.def.memory_mb || 0) * 1024 * 1024;
    const mem = r.status.mem_bytes;
    const memPct = (capBytes > 0 && mem != null && mem > 0)
      ? Math.min(100, (mem / capBytes) * 100) : null;

    const buf = PERF_HISTORY.get(name) || [];
    let cpuPct = null;
    const prev = buf[buf.length - 1];
    if (prev && r.status.cpu_usec != null && prev.cpu_usec != null
        && r.status.cpu_usec >= prev.cpu_usec) {
      const dNs = r.status.cpu_usec - prev.cpu_usec;      // nanoseconds
      const dMs = now - prev.t_ms;
      if (dMs > 0) {
        // 100 * (delta CPU seconds / delta wall seconds); ns / 1e6 = ms.
        cpuPct = Math.max(0, Math.min(999, (dNs / 1e6 / dMs) * 100));
      }
    }
    buf.push({
      t_ms: now,
      active: r.status.active,
      mem_bytes: mem, cpu_usec: r.status.cpu_usec,
      uptime_sec: r.status.uptime_sec,
      mem_pct: memPct, cpu_pct: cpuPct,
    });
    while (buf.length > PERF_MAX) buf.shift();
    PERF_HISTORY.set(name, buf);
  }

  // If the perf panel is open for a server, redraw.
  if (CURRENT && !$("#detail-panel").hidden && !$('.subtab-body[data-body="control"]').hidden) {
    renderPerfPanel(CURRENT);
  }
}

function renderPerfPanel(name) {
  const buf = PERF_HISTORY.get(name) || [];
  const latest = buf[buf.length - 1] || null;

  $("#perf-state").textContent = latest ? (latest.active || "-") : "-";
  $("#perf-uptime").textContent = latest ? fmtDur(latest.uptime_sec) : "-";
  $("#perf-ram").textContent = latest && latest.mem_bytes != null
    ? `${fmtBytes(latest.mem_bytes)} (${latest.mem_pct != null ? latest.mem_pct.toFixed(0) + "%" : "-"})`
    : "-";
  $("#perf-cpu").textContent = latest && latest.cpu_pct != null
    ? `${latest.cpu_pct.toFixed(0)}%`
    : (buf.length < 2 ? "(collecting…)" : "-");

  drawSpark($("#spark-ram"), buf.map(x => x.mem_pct), 100);
  drawSpark($("#spark-cpu"), buf.map(x => x.cpu_pct),
    // CPU can exceed 100% on multi-core boxes. Auto-scale to the max seen.
    Math.max(100, ...buf.map(x => x.cpu_pct || 0)));
}

function drawSpark(svg, series, ymax) {
  if (!svg) return;
  const w = 100, h = 30;
  const pts = series.filter(v => v != null);
  if (pts.length < 2) { svg.innerHTML = ""; return; }
  const step = w / (PERF_MAX - 1);
  const pad = PERF_MAX - series.length;
  const coords = series.map((v, i) => {
    if (v == null) return null;
    const x = (i + pad) * step;
    const y = h - (v / ymax) * h;
    return [x, Math.max(1, Math.min(h - 1, y))];
  }).filter(Boolean);
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const first = coords[0], last = coords[coords.length - 1];
  const fillPath = `${first[0].toFixed(1)},${h} L ${line} L ${last[0].toFixed(1)},${h} Z`;
  const cur = pts[pts.length - 1];
  const cls = cur > 90 ? "err" : cur > 75 ? "warn" : "";
  svg.setAttribute("class", "sparkline " + cls);
  svg.innerHTML = `<path class="fill" d="M ${fillPath}"/><polyline points="${line}"/>`;
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

    // Access-mode chip (public / steamid_allowlist / ip_allowlist).
    const accessMode = (d.access && d.access.mode) || "public";
    let accessChip = "";
    if (accessMode === "steamid_allowlist") {
      const n = (d.access.allowed_steamids || []).length;
      accessChip = `<span class="chip chip-lock" title="Steam ID allowlist (${n})">🔒 ${n} IDs</span>`;
    } else if (accessMode === "ip_allowlist") {
      const n = (d.access.allowed_ips || []).length;
      accessChip = `<span class="chip chip-lock" title="IP allowlist (${n})">🔒 ${n} IPs</span>`;
    }

    // Watchdog / idle-shutdown chip (only when server is running and
    // idle_shutdown_min is set). Shows current player count and, if empty,
    // the countdown to auto-shutdown.
    let idleChip = "";
    const wd = r.watchdog;
    if (d.idle_shutdown_min && s.active === "active" && wd) {
      const pl = wd.players;
      if (pl == null || !wd.probe_ok) {
        idleChip = `<span class="chip" title="Waiting for A2S/SLP probe response">👥 —</span>`;
      } else if (pl > 0) {
        const max = wd.max_players ? `/${wd.max_players}` : "";
        idleChip = `<span class="chip chip-ok" title="Players online">👥 ${pl}${max}</span>`;
      } else {
        const remainMin = Math.max(0, d.idle_shutdown_min - Math.floor((wd.empty_sec || 0) / 60));
        idleChip = `<span class="chip chip-warn" title="Empty; auto-shutdown countdown">💤 ${remainMin}m</span>`;
      }
    }

    // Wake-on-demand chip. Different label depending on whether the
    // proxy is currently sleeping (game stopped, awaiting a connection)
    // or actively waking one up.
    let wakeChip = "";
    if (d.wake_on_demand) {
      const wk = r.wake;
      if (wk && wk.waking) {
        wakeChip = `<span class="chip chip-warn" title="Buffered ${wk.buffered_packets} pkts; waking (${wk.waking_sec}s)">🌙 waking…</span>`;
      } else if (s.active === "active") {
        wakeChip = `<span class="chip chip-accent" title="Proxy is relaying to :${wk?.internal_port || (d.port + 10000)}">🌙 relay</span>`;
      } else {
        wakeChip = `<span class="chip" title="Wake proxy listening — first client packet will start the server">🌙 sleeping</span>`;
      }
    }

    // Connect string: what a player types into the game client. Uses the
    // hostname the operator is currently browsing on (works over LAN, VPN,
    // and DNS names). Copy button on the right.
    const host = window.location.hostname || "your-lxc";
    const connectStr = `${host}:${d.port}`;

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
        ${accessChip}
        ${idleChip}
        ${wakeChip}
      </div>
      <div class="server-card-connect">
        <span class="connect-label">Connect</span>
        <code class="connect-str">${escape(connectStr)}</code>
        <button class="btn btn-tiny btn-ghost" data-copy="${escape(connectStr)}" title="Copy">📋</button>
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
  if (t.dataset.copy) {
    ev.preventDefault(); ev.stopPropagation();
    try {
      await navigator.clipboard.writeText(t.dataset.copy);
      const prev = t.textContent;
      t.textContent = "✓";
      setTimeout(() => { t.textContent = prev; }, 900);
    } catch (e) { alert("Copy failed: " + e.message); }
    return;
  }
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
  // Clear any progress widget carried over from a previously-opened server;
  // resumeJobIfRunning() below re-shows it if this server has a live job.
  clearInterval(JOB_TIMER); JOB_TIMER = null;
  hideProgress();
  showTab("control");
  refreshServers();  // to re-highlight the selected card
  $("#detail-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  resumeJobIfRunning(name);
  loadIdleWakePanel(name);
}

// ---------- Idle / Wake control panel (on the Control tab) ----------
// Populates + saves the two per-server toggles without needing to touch
// the raw JSON in the Definition tab. Values live in the ServerDef under
// idle_shutdown_min / wake_on_demand / wake_timeout_sec.

// Cached snapshot of the def so we can spot whether a save flipped the
// wake toggle (which requires a Reinstall) and hint accordingly.
let IW_PREV_DEF = null;

async function loadIdleWakePanel(name) {
  try {
    const r = await api(`/api/servers/${name}`);
    const d = r.def || {};
    IW_PREV_DEF = d;

    const idleMin = d.idle_shutdown_min || 0;
    $("#iw-idle-enabled").checked = idleMin > 0;
    $("#iw-idle-min").value = idleMin > 0 ? idleMin : 20;
    $("#iw-idle-status").textContent = "";

    $("#iw-wake-enabled").checked = !!d.wake_on_demand;
    $("#iw-wake-sec").value = d.wake_timeout_sec || 90;
    $("#iw-wake-status").textContent = "";
    $("#iw-reinstall-hint").hidden = true;
  } catch (e) {
    $("#iw-idle-status").textContent = "ERROR: " + e.message;
  }
}

async function _saveDefPatch(name, patch, statusEl) {
  statusEl.textContent = "saving…";
  try {
    const r = await api(`/api/servers/${name}`);
    const sd = Object.assign({}, r.def, patch);
    await api("/api/servers", { method: "POST", body: JSON.stringify(sd) });
    statusEl.textContent = "✓ saved";
    setTimeout(() => { if (statusEl.textContent === "✓ saved") statusEl.textContent = ""; }, 2500);
    refreshServers();
    return sd;
  } catch (e) {
    statusEl.textContent = "ERROR: " + e.message;
    return null;
  }
}

$("#iw-save-idle")?.addEventListener("click", async () => {
  if (!CURRENT) return;
  const enabled = $("#iw-idle-enabled").checked;
  const raw = parseInt($("#iw-idle-min").value, 10);
  const minVal = enabled ? (Number.isFinite(raw) && raw > 0 ? raw : 20) : null;
  await _saveDefPatch(CURRENT, { idle_shutdown_min: minVal }, $("#iw-idle-status"));
});

$("#iw-save-wake")?.addEventListener("click", async () => {
  if (!CURRENT) return;
  const enabled = $("#iw-wake-enabled").checked;
  const rawTo = parseInt($("#iw-wake-sec").value, 10);
  const timeout = Number.isFinite(rawTo) && rawTo >= 10 ? Math.min(600, rawTo) : 90;

  // Guard: public port must fit port + 10000 <= 65535 when enabling.
  if (enabled && IW_PREV_DEF && IW_PREV_DEF.port && IW_PREV_DEF.port + 10000 > 65535) {
    $("#iw-wake-status").textContent =
      "ERROR: public port too high (needs <= 55535 to reserve port+10000 for the game)";
    return;
  }

  const toggleChanged = !!(IW_PREV_DEF && IW_PREV_DEF.wake_on_demand !== enabled);
  const sd = await _saveDefPatch(CURRENT, {
    wake_on_demand: enabled,
    wake_timeout_sec: timeout,
  }, $("#iw-wake-status"));
  if (sd) {
    IW_PREV_DEF = sd;
    // A wake toggle changes the port the game binds. Warn loudly so the
    // operator remembers to Reinstall before the next start.
    $("#iw-reinstall-hint").hidden = !toggleChanged;
  }
});

// Enter key in the number fields saves the corresponding row.
$("#iw-idle-min")?.addEventListener("keydown", (e) => { if (e.key === "Enter") $("#iw-save-idle").click(); });
$("#iw-wake-sec")?.addEventListener("keydown", (e) => { if (e.key === "Enter") $("#iw-save-wake").click(); });

async function resumeJobIfRunning(name) {
  try {
    const j = await api(`/api/servers/${name}/job`);
    if (j.exists && !j.done) {
      showProgress(j.kind || "install");
      updateProgress(j);
      pollJob(name);
    }
  } catch (e) { /* no token / no server — silent */ }
}

function showTab(name) {
  $$(".subtab").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  $$(".subtab-body").forEach(b => b.hidden = b.dataset.body !== name);

  // Kill followers on tab switch — we restart them below only for the
  // tab that owns them.
  clearInterval(LOGS_TIMER); LOGS_TIMER = null;
  clearInterval(CONSOLE_TIMER); CONSOLE_TIMER = null;

  if (name === "logs") {
    loadLogs();
    if ($("#logs-follow")?.checked) LOGS_TIMER = setInterval(loadLogs, 2000);
  }
  if (name === "console") {
    loadConsoleLog();
    if ($("#console-follow")?.checked) CONSOLE_TIMER = setInterval(loadConsoleLog, 2000);
  }
  if (name === "files") listFiles();
  if (name === "backups") loadBackups();
  if (name === "def") loadDef();
  if (name === "git") loadGit();
}
$$(".subtab").forEach(b => b.onclick = () => showTab(b.dataset.tab));

// Control tab
document.addEventListener("click", async (ev) => {
  const action = ev.target.dataset.action;
  if (!action || !CURRENT) return;
  // Install and Update Game Software run as background jobs so the UI can
  // stream a progress bar (SteamCMD downloads can take a while).
  if (action === "install" || action === "update-type") {
    await startInstallJob(action);
    return;
  }
  try {
    const path = `/api/servers/${CURRENT}/action`;
    const opts = { method: "POST", body: JSON.stringify({ action }) };
    const r = await api(path, opts);
    $("#control-out").textContent = JSON.stringify(r, null, 2);
    setTimeout(refreshServers, 500);
  } catch (e) { $("#control-out").textContent = "ERROR: " + e.message; }
});

// ---------- Install / Update / Backup / Restore progress ----------
// The install, update, backup and restore endpoints all return a job id;
// we poll GET /api/servers/<name>/job every ~1s and paint the shared
// progress widget (above the subtabs) until job.done is true.

let JOB_TIMER = null;
let JOB_SERVER = null;

async function startInstallJob(action) {
  const kind = action === "install" ? "install" : "update";
  const path = kind === "install"
    ? `/api/servers/${CURRENT}/install`
    : `/api/servers/${CURRENT}/update`;
  return startJob(kind, path);
}

async function startJob(kind, path, extra = {}) {
  $("#control-out").textContent = "";
  showProgress(kind);
  const opts = { method: "POST", ...extra };
  try {
    await api(path, opts);
    pollJob(CURRENT);
  } catch (e) {
    // 409 = a job is already running for this server — resume polling.
    if (String(e.message).includes("HTTP 409") && !String(e.message).includes("stop the server")) {
      pollJob(CURRENT);
    } else {
      $("#progress-status").textContent = "failed to start";
      $("#progress-tail").hidden = false;
      $("#progress-show-log").checked = true;
      $("#progress-tail").textContent = "ERROR: " + e.message;
    }
  }
}

function pollJob(server) {
  clearInterval(JOB_TIMER);
  JOB_SERVER = server;
  const tick = async () => {
    // Stop polling if the user switched servers.
    if (CURRENT !== JOB_SERVER) { clearInterval(JOB_TIMER); JOB_TIMER = null; return; }
    try {
      const j = await api(`/api/servers/${server}/job`);
      if (!j.exists) { clearInterval(JOB_TIMER); JOB_TIMER = null; return; }
      updateProgress(j);
      if (j.done) {
        clearInterval(JOB_TIMER); JOB_TIMER = null;
        finalizeProgress(j);
        setTimeout(refreshServers, 500);
      }
    } catch (e) {
      // Transient error — keep polling; a permanent auth failure will
      // surface via the auth badge elsewhere.
      console.warn("job poll failed", e);
    }
  };
  tick();
  JOB_TIMER = setInterval(tick, 1000);
}

function showProgress(kind) {
  $("#install-progress").hidden = false;
  $("#progress-kind").textContent = kind;
  $("#progress-phase").textContent = "starting…";
  $("#progress-status").textContent = "";
  $("#progress-percent").textContent = "0%";
  $("#progress-bytes").textContent = "";
  $("#progress-elapsed").textContent = "";
  $("#progress-bar-fill").style.width = "0%";
  $("#progress-bar-fill").classList.remove("ok", "err");
  $("#progress-tail").textContent = "";
}

function hideProgress() { $("#install-progress").hidden = true; }

function updateProgress(j) {
  const p = j.progress || {};
  const pct = Math.max(0, Math.min(100, Number(p.percent) || 0));
  $("#progress-bar-fill").style.width = pct.toFixed(2) + "%";
  $("#progress-percent").textContent = pct.toFixed(1) + "%";
  $("#progress-phase").textContent = p.phase || (j.done ? (j.ok ? "complete" : "failed") : "working…");
  $("#progress-kind").textContent = j.kind || "install";
  const bd = Number(p.bytes_done) || 0;
  const bt = Number(p.bytes_total) || 0;
  $("#progress-bytes").textContent = (bd && bt) ? `${fmtBytes(bd)} / ${fmtBytes(bt)}` : "";
  $("#progress-elapsed").textContent = j.elapsed_sec ? `${fmtDur(Math.round(j.elapsed_sec))} elapsed` : "";
  const tailEl = $("#progress-tail");
  const wasAtBottom = tailEl.scrollTop + tailEl.clientHeight >= tailEl.scrollHeight - 10;
  const lines = (j.tail || []).slice(-100);
  tailEl.textContent = lines.join("\n");
  if (wasAtBottom) tailEl.scrollTop = tailEl.scrollHeight;
}

function finalizeProgress(j) {
  const fill = $("#progress-bar-fill");
  if (j.ok) {
    fill.classList.add("ok");
    $("#progress-status").textContent = `✓ done in ${fmtDur(Math.round(j.elapsed_sec))}`;
    $("#control-out").textContent = (j.messages || []).join("\n\n");
    // Auto-hide on success; keep the log on-screen on failure.
    setTimeout(() => { if ($("#install-progress").querySelector("#progress-status").textContent.startsWith("✓")) hideProgress(); }, 6000);
  } else {
    fill.classList.add("err");
    $("#progress-status").textContent = `✕ ${j.error || "failed"}`;
    $("#control-out").textContent = "ERROR: " + (j.error || "install failed") +
      "\n\n" + (j.tail || []).join("\n");
    // Force the log open so the user can see what went wrong.
    $("#progress-show-log").checked = true;
    $("#progress-tail").hidden = false;
  }
  // Refresh state-dependent panels after backup/restore completes.
  if (j.ok && (j.kind === "backup" || j.kind === "restore")) {
    loadBackups();
  }
}

// Wire progress-widget controls (close + show-log toggle).
document.addEventListener("DOMContentLoaded", () => {
  const closeBtn = $("#progress-close");
  const toggle = $("#progress-show-log");
  if (closeBtn) closeBtn.onclick = () => hideProgress();
  if (toggle) toggle.onchange = () => { $("#progress-tail").hidden = !toggle.checked; };
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
    // Quick refresh so the server's reply lands in the pane above.
    setTimeout(loadConsoleLog, 400);
  } catch (e) { $("#console-out").textContent = "ERROR: " + e.message; }
};

// Send on Enter as well as via the button.
$("#console-cmd")?.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") { ev.preventDefault(); $("#console-send").click(); }
});

// Logs — one-shot refresh + optional follow.
let LOGS_TIMER = null;
async function loadLogs() {
  const n = $("#log-lines").value || 200;
  try {
    const txt = await api(`/api/servers/${CURRENT}/logs?lines=${encodeURIComponent(n)}`);
    const el = $("#logs-out");
    // Preserve scroll-at-bottom "tail" behavior.
    const wasAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
    el.textContent = txt;
    if (wasAtBottom) el.scrollTop = el.scrollHeight;
  } catch (e) { $("#logs-out").textContent = "ERROR: " + e.message; }
}
$("#refresh-logs").onclick = loadLogs;
$("#logs-follow").addEventListener("change", (ev) => {
  clearInterval(LOGS_TIMER); LOGS_TIMER = null;
  if (ev.target.checked) LOGS_TIMER = setInterval(loadLogs, 2000);
});

// Console — same log source as the Logs tab, refreshed above the input so
// you can see the server's response to a command in real time.
let CONSOLE_TIMER = null;
async function loadConsoleLog() {
  const n = $("#console-lines").value || 120;
  try {
    const txt = await api(`/api/servers/${CURRENT}/logs?lines=${encodeURIComponent(n)}`);
    const el = $("#console-log-out");
    const wasAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
    el.textContent = txt;
    if (wasAtBottom) el.scrollTop = el.scrollHeight;
  } catch (e) {
    $("#console-log-out").textContent = "ERROR: " + e.message;
  }
}
$("#console-refresh")?.addEventListener("click", loadConsoleLog);
$("#console-follow")?.addEventListener("change", (ev) => {
  clearInterval(CONSOLE_TIMER); CONSOLE_TIMER = null;
  if (ev.target.checked) CONSOLE_TIMER = setInterval(loadConsoleLog, 2000);
});

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
  // Streams progress through the shared job widget above the subtabs.
  await startJob("backup", `/api/servers/${CURRENT}/backup`);
};
document.addEventListener("click", async (ev) => {
  const name = ev.target.dataset.restore;
  if (!name || !CURRENT) return;
  if (!confirm(`Restore ${name}? Server must be STOPPED. Existing world will be moved aside.`)) return;
  await startJob("restore", `/api/servers/${CURRENT}/restore`, {
    body: JSON.stringify({ backup_name: name }),
  });
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
// GIT SOURCE TAB
// ========================================================================

// Populate the Git tab from the loaded server def. Called when the tab is
// opened AND after every save so the fields reflect what's on disk.
async function loadGit() {
  try {
    const r = await api(`/api/servers/${CURRENT}`);
    const g = r.def.git_source || {};
    $("#g-url").value          = g.url || "";
    $("#g-ref").value          = g.ref || "";
    $("#g-subdir").value       = g.subdir || "";
    $("#g-world-subdir").value = g.world_subdir || "";
    $("#g-token-env").value    = g.token_env || "";
    $("#g-exclude").value      = (g.exclude || []).join(", ");
    renderGitInfo(g, null);
  } catch (e) {
    $("#git-out").textContent = "ERROR: " + e.message;
  }
}

function renderGitInfo(gitCfg, statusResp) {
  const box = $("#git-info");
  if (!gitCfg || !gitCfg.url) { box.hidden = true; return; }
  box.hidden = false;
  $("#git-info-ref").textContent = gitCfg.deployed_ref || "(never deployed)";
  $("#git-info-sha").textContent = (gitCfg.deployed_sha || "").slice(0, 12) || "-";
  $("#git-info-at").textContent  = gitCfg.deployed_at || "-";
  const upd = $("#git-info-update");
  if (statusResp?.ok && statusResp.update_available) {
    upd.innerHTML = `<span class="chip chip-warn">update available → ${statusResp.remote_short_sha}</span>`;
  } else if (statusResp?.ok) {
    upd.innerHTML = `<span class="chip chip-ok">up to date</span>`;
  } else if (statusResp && !statusResp.ok) {
    upd.innerHTML = `<span class="chip chip-err">${escape(statusResp.error || "remote check failed")}</span>`;
  } else {
    upd.innerHTML = "";
  }
}

// Build the git_source object from the tab's inputs.
function collectGitSource() {
  const excl = $("#g-exclude").value
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  return {
    url:          $("#g-url").value.trim(),
    ref:          $("#g-ref").value.trim(),
    subdir:       $("#g-subdir").value.trim(),
    world_subdir: $("#g-world-subdir").value.trim(),
    token_env:    $("#g-token-env").value.trim(),
    exclude:      excl,
  };
}

// Save git_source into the server def without touching the rest of it.
async function saveGitSource() {
  const r = await api(`/api/servers/${CURRENT}`);
  const sd = r.def;
  const g = collectGitSource();
  // Preserve deployed_* fields when re-saving.
  const prev = sd.git_source || {};
  sd.git_source = {
    ...g,
    deployed_sha: prev.deployed_sha || "",
    deployed_ref: prev.deployed_ref || "",
    deployed_at:  prev.deployed_at  || "",
  };
  await api("/api/servers", { method: "POST", body: JSON.stringify(sd) });
}

$("#git-save")?.addEventListener("click", async () => {
  try {
    await saveGitSource();
    $("#git-out").textContent = "git_source saved.";
    await loadGit();
    refreshServers();
  } catch (e) { $("#git-out").textContent = "ERROR: " + e.message; }
});

$("#git-status")?.addEventListener("click", async () => {
  try {
    // Save first so the endpoint uses what the user just typed.
    await saveGitSource();
    const tok = ($("#g-token").value || "").trim();
    const s = await api(`/api/servers/${CURRENT}/git/status`, {
      method: "POST", body: JSON.stringify({ token: tok || null }),
    });
    $("#git-out").textContent = JSON.stringify(s, null, 2);
    const rr = await api(`/api/servers/${CURRENT}`);
    renderGitInfo(rr.def.git_source || {}, s);
    // Don't clear the PAT here — the user probably wants to hit "Pull & deploy" next.
  } catch (e) { $("#git-out").textContent = "ERROR: " + e.message; }
});

$("#git-sync")?.addEventListener("click", async () => {
  if (!confirm(
    "Pull the latest ref and rsync the tree into install_dir?\n\n" +
    "This overwrites any files in install_dir that also exist in the repo. " +
    "Manually-uploaded files not present in the repo are preserved."
  )) return;
  try {
    await saveGitSource();
    const tok = ($("#g-token").value || "").trim();
    $("#git-out").textContent = "syncing…";
    const r = await api(`/api/servers/${CURRENT}/git/sync`, {
      method: "POST", body: JSON.stringify({ dry_run: false, token: tok || null }),
    });
    $("#git-out").textContent = JSON.stringify(r, null, 2);
    $("#g-token").value = "";   // forget the PAT — never persisted
    await loadGit();
    refreshServers();
  } catch (e) { $("#git-out").textContent = "ERROR: " + e.message; }
});

$("#git-dry-run")?.addEventListener("click", async () => {
  try {
    await saveGitSource();
    const tok = ($("#g-token").value || "").trim();
    $("#git-out").textContent = "dry-running…";
    const r = await api(`/api/servers/${CURRENT}/git/sync`, {
      method: "POST", body: JSON.stringify({ dry_run: true, token: tok || null }),
    });
    $("#git-out").textContent = JSON.stringify(r, null, 2);
  } catch (e) { $("#git-out").textContent = "ERROR: " + e.message; }
});

$("#git-clear")?.addEventListener("click", async () => {
  if (!confirm("Delete the .gitsrc cache dir? Next sync will do a full clone.")) return;
  try {
    const r = await api(`/api/servers/${CURRENT}/git/clear-cache`, { method: "POST" });
    $("#git-out").textContent = JSON.stringify(r, null, 2);
  } catch (e) { $("#git-out").textContent = "ERROR: " + e.message; }
});

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
  syncAccessMode();
  syncWakeToggle();
  modal.hidden = false;
  setTimeout(() => $("#f-name").focus(), 30);
}
function closeNewServerModal() {
  // Explicitly clear the PAT field even though form.reset() would do it on
  // next open — defense in depth in case the browser autofills it back.
  const tokenEl = document.getElementById("f-git-token");
  if (tokenEl) tokenEl.value = "";
  $("#modal-backdrop").hidden = true;
}

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
  // Passwords fieldset only makes sense for SteamCMD games (Palworld / ARK /
  // Valheim get real injection; other steamcmd apps get an advisory note).
  $("#fs-passwords").hidden = type !== "steamcmd";

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

// Access-mode toggle: show/hide the appropriate allowlist textarea.
$("#f-access-mode")?.addEventListener("change", () => syncAccessMode());
function syncAccessMode() {
  const mode = $("#f-access-mode").value;
  $("#f-steamids-wrap").hidden = mode !== "steamid_allowlist";
  $("#f-ips-wrap").hidden      = mode !== "ip_allowlist";
}

// Wake-on-demand toggle: only expose the timeout field when the box is checked.
$("#f-wake-on-demand")?.addEventListener("change", () => syncWakeToggle());
function syncWakeToggle() {
  const on = $("#f-wake-on-demand").checked;
  $("#f-wake-timeout-wrap").hidden = !on;
}

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

  // Access control: mode + the matching allowlist. We always send the
  // block so the server side sees defaults explicitly (not a missing key
  // that gets filled in with model defaults).
  const accessMode = $("#f-access-mode").value || "public";
  const parseLines = (s) => (s || "")
    .split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
  sd.access = {
    mode: accessMode,
    allowed_steamids: accessMode === "steamid_allowlist" ? parseLines($("#f-steamids").value) : [],
    allowed_ips:      accessMode === "ip_allowlist"      ? parseLines($("#f-ips").value)      : [],
  };

  // Scale-to-zero
  const idleMinRaw = $("#f-idle-min").value.trim();
  if (idleMinRaw) {
    const n = parseInt(idleMinRaw, 10);
    if (Number.isFinite(n) && n > 0) sd.idle_shutdown_min = n;
  }

  // Wake-on-demand (v1: UDP games only). The manager's proxy owns the
  // public port and remaps the game to port+10000 on Install.
  if ($("#f-wake-on-demand").checked) {
    sd.wake_on_demand = true;
    const wto = parseInt($("#f-wake-timeout").value, 10);
    if (Number.isFinite(wto) && wto >= 10) sd.wake_timeout_sec = wto;
    if (sd.port && sd.port + 10000 > 65535) {
      showFormError("Wake-on-demand requires a public port <= 55535 (internal port = port + 10000)");
      return;
    }
  }

  // Passwords (SteamCMD games only — the fieldset is hidden otherwise).
  if (type === "steamcmd") {
    const spw = $("#f-server-pw").value;
    const apw = $("#f-admin-pw").value;
    if (spw || apw) {
      sd.passwords = { server_password: spw, admin_password: apw };
    }
  }

  // git_source (optional). Only added if a URL was supplied.
  const gitUrl = $("#f-git-url").value.trim();
  if (gitUrl) {
    sd.git_source = {
      url:          gitUrl,
      ref:          $("#f-git-ref").value.trim(),
      subdir:       $("#f-git-subdir").value.trim(),
      world_subdir: $("#f-git-world-subdir").value.trim(),
      token_env:    $("#f-git-token-env").value.trim(),
      exclude:      [],
    };
  }

  try {
    await api("/api/servers", { method: "POST", body: JSON.stringify(sd) });
  } catch (e) {
    showFormError("Create failed: " + e.message);
    return;
  }

  // If a git_source URL was provided, do the initial pull BEFORE running
  // any queued file uploads — so the file uploads land on top of the repo
  // tree (user's manual additions win over repo defaults).
  if (gitUrl) {
    const saveBtn = $("#modal-save");
    saveBtn.disabled = true;
    saveBtn.textContent = "Cloning from git…";
    const initToken = ($("#f-git-token").value || "").trim();
    try {
      const r = await api(`/api/servers/${sd.name}/git/sync`, {
        method: "POST",
        body: JSON.stringify({ dry_run: false, token: initToken || null }),
      });
      $("#f-git-token").value = "";   // forget the PAT — never persisted
      showFormError(""); $("#form-error").hidden = true;
      // Keep going — but leave a small breadcrumb in the file-summary line
      const summary = $("#init-file-summary");
      summary.hidden = false;
      summary.textContent = `git: pulled ${r.short_sha} from ${r.ref}` +
        (r.world_updated ? " (+ world_subdir)" : "");
    } catch (e) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Create Server";
      showFormError(
        `Server created, but the initial git sync failed:\n\n${e.message}\n\n` +
        `Fix the git_source on the server's Git tab (paste a PAT into ` +
        `"PAT for this sync" if the repo is private), or Cancel to close.`
      );
      await refreshServers();
      return;
    }
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
