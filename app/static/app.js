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
      // Auto-run the network diagnostic so operators see "likely blocked
      // upstream" verdicts without having to click Refresh — the whole
      // point is that the Admin page is where you go when a server is
      // misbehaving, so surface the diagnosis immediately.
      loadNetworkDiagnostics();
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
//
// When the systemd unit is `active` but the manager has a game-specific
// readiness probe (Steam A2S / Minecraft SLP / Satisfactory HTTPS API)
// AND that probe hasn't succeeded yet since the server started, we show
// a "starting" chip instead of "running" — the game process is up but
// still loading the world and is NOT yet accepting client connections.
// This closes the "the dashboard says running but the client times out"
// UX gap on games with multi-minute world-load times (Satisfactory
// especially).
//
// Two escalations when starting takes unusually long (thresholds from
// watchdog._State: slow_start=5min, stuck_start=20min):
//   * slow_start   → "◐ starting… (slow)" in warn color. Hint that the
//                    game is legitimately slow to load OR something is
//                    wrong; user should check the Console tab.
//   * stuck_start  → "◐ starting? check Console" in error color. The
//                    game process likely crashed or is hung — visible
//                    signal instead of an amber chip forever.
function stateChip(active, sub, ready, probeSupported, wd, statusExtra) {
  const s = (active || "unknown").toLowerCase();
  if (s === "active") {
    // Crash-restart loop: systemd has restarted this unit N>0 times AND
    // the current uptime is short (<2 min). This is the fingerprint that
    // catches the "console.log shows the same first-boot lines forever"
    // trap, where each restart truncates console.log via start.sh so the
    // operator can't see anything after the boot banner. Surface it
    // prominently so waiting for "starting → running" isn't the answer.
    const nRestarts = (statusExtra && statusExtra.n_restarts) || 0;
    const uptimeSec = (statusExtra && statusExtra.uptime_sec) || 0;
    if (nRestarts > 0 && uptimeSec < 120) {
      return {
        cls: "chip-err",
        label: `↻ restart loop (${nRestarts})`,
        title: `The systemd unit has restarted ${nRestarts} times. Uptime is only ${uptimeSec}s — the game process is crashing shortly after launch. Check journalctl -u gamesrv@<name> --since '5 min ago' for the exit reason (common causes: OOM kill, missing library, bad config).`,
      };
    }
    if (probeSupported && !ready) {
      const startingSec = (wd && wd.starting_sec) || 0;
      if (wd && wd.stuck_start) {
        const mins = Math.floor(startingSec / 60);
        return {
          cls: "chip-err",
          label: `◐ starting? (${mins}m)`,
          title: `Systemd unit is active but the readiness probe hasn't succeeded in ${mins} minutes. The game likely crashed or is hung — check the Console tab for real output.`,
        };
      }
      if (wd && wd.slow_start) {
        const mins = Math.floor(startingSec / 60);
        return {
          cls: "chip-warn",
          label: `◐ starting… (${mins}m)`,
          title: `Taking longer than usual (${mins}m). Big worlds (ARK, modded MC) do this; if it's a smaller game check the Console tab for errors.`,
        };
      }
      return { cls: "chip-warn", label: "◐ starting" };
    }
    return { cls: "chip-ok", label: `● ${sub || "running"}` };
  }
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

// ---------- Network diagnostics (host firewall / bridge-nf) ----------
// Detects the specific failure mode where a game server is bound locally
// and healthy but LAN clients can't reach it — usually because the
// Proxmox host's bridge-nf-call-iptables is dropping the packets. See
// scripts/proxmox-host-fix.sh for the one-shot host-side fix.
async function loadNetworkDiagnostics() {
  const summaryChip = $("#netdiag-summary");
  const results = $("#netdiag-results");
  const hostFix = $("#netdiag-hostfix");
  summaryChip.textContent = "checking…";
  summaryChip.className = "chip chip-warn";
  results.innerHTML = "";
  hostFix.hidden = true;

  // Kick off keyctl check in parallel with the network check — different
  // failure modes, both diagnosable, both host-config fixable.
  loadKeyctlDiagnostic();

  try {
    const d = await api("/api/diagnostics/network");
    if (!d.servers || d.servers.length === 0) {
      summaryChip.textContent = "no servers to check";
      summaryChip.className = "chip chip-muted";
      results.innerHTML = "<p class='muted small'>Create a server first, then re-run the check.</p>";
      return;
    }
    let unreachableCount = 0;
    const rows = d.servers.map((s) => {
      const flagged = s.looks_externally_unreachable;
      if (flagged) unreachableCount++;
      const secStr = s.starting_sec ? `${Math.floor(s.starting_sec / 60)}m ${s.starting_sec % 60}s` : "-";
      const recvStr = s.recv_q == null ? "n/a" : `${s.recv_q} B`;
      const cls = flagged
        ? "chip-err"
        : (s.ready ? "chip-ok" : (s.active === "active" ? "chip-warn" : "chip-muted"));
      const label = flagged
        ? "⚠ likely blocked upstream"
        : (s.ready ? "✔ probe OK" : (s.active === "active" ? "◐ still starting" : "○ not running"));
      return `
        <tr>
          <td><code>${s.name}</code></td>
          <td><code>:${s.port}</code></td>
          <td>${s.active}</td>
          <td>${secStr}</td>
          <td>${recvStr}</td>
          <td><span class="chip ${cls}">${label}</span></td>
        </tr>`;
    }).join("");
    results.innerHTML = `
      <table class="kv" style="width:100%;">
        <thead>
          <tr>
            <th style="text-align:left;">Server</th>
            <th style="text-align:left;">Port</th>
            <th style="text-align:left;">Active</th>
            <th style="text-align:left;">Starting for</th>
            <th style="text-align:left;">Recv-Q</th>
            <th style="text-align:left;">Verdict</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="small muted" style="margin-top:8px;">
        <strong>Recv-Q</strong> is the number of bytes queued on the game's UDP socket
        waiting to be read. If it's 0 while the server has been "starting" for &gt;5 minutes,
        that means no packets are arriving on the port — which is diagnostic of a block
        upstream of the LXC (Proxmox host firewall, bridge iptables, or the client's
        outbound firewall).
      </p>`;
    if (unreachableCount > 0) {
      summaryChip.textContent = `${unreachableCount} likely blocked upstream`;
      summaryChip.className = "chip chip-err";
      hostFix.hidden = false;
    } else {
      summaryChip.textContent = "all clear";
      summaryChip.className = "chip chip-ok";
    }
  } catch (e) {
    summaryChip.textContent = "check failed";
    summaryChip.className = "chip chip-err";
    results.innerHTML = `<p class='form-error'>${e.message}</p>`;
  }
}
$("#netdiag-refresh")?.addEventListener("click", loadNetworkDiagnostics);

// keyctl syscall availability check. Palworld and other Steam-session-auth
// games hang silently if keyctl is blocked by the LXC's syscall filter.
// Detects it, tells the operator how to fix on the Proxmox host.
async function loadKeyctlDiagnostic() {
  const chip = $("#keyctl-summary");
  const detail = $("#keyctl-detail");
  if (!chip || !detail) return;   // panel not present in older templates
  chip.textContent = "checking…";
  chip.className = "chip chip-warn";
  detail.hidden = true;
  try {
    const d = await api("/api/diagnostics/keyctl");
    if (d.keyctl_available) {
      chip.textContent = "keyctl available";
      chip.className = "chip chip-ok";
      detail.hidden = true;
    } else {
      chip.textContent = `⚠ keyctl blocked (${d.syscall_error_name || "?"})`;
      chip.className = "chip chip-err";
      detail.hidden = false;
      detail.innerHTML = `
        <p><strong>keyctl() syscall is blocked in this LXC.</strong>
        Palworld and other Steamworks games that use session-keyring auth
        will hang silently after "Running &lt;game&gt; on :PORT" with RAM
        stuck around 1 GB, no crash, no error. Satisfactory / Minecraft /
        games that don't use that specific Steam code path are unaffected.</p>
        <p><strong>Fix on the Proxmox HOST</strong> (not this LXC):</p>
        <pre style="background:#0004;padding:8px;border-radius:4px;"># On the Proxmox host as root, replace 106 with your CT ID:
grep '^features:' /etc/pve/lxc/106.conf || echo "no features line"
# If missing:  echo 'features: nesting=1,keyctl=1' &gt;&gt; /etc/pve/lxc/106.conf
# If present:  edit the line to add ,keyctl=1 (e.g. features: nesting=1,keyctl=1)
pct restart 106</pre>
        <p class="small muted">${(d.detail || "").replace(/</g, "&lt;")}</p>`;
    }
  } catch (e) {
    chip.textContent = "keyctl check failed";
    chip.className = "chip chip-muted";
  }
}

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
    // Refresh the RAM history chart if the card is visible. Fetching is
    // independent of the stats above (different endpoint + user-selected
    // timeframe) so we don't parallelize inside the Promise.all above.
    refreshRamChart().catch(() => {});
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

// ---------- Rolling RAM history chart ----------
//
// The manager samples aggregate RAM every 15s (see app/perf.py) and
// keeps up to 24h in memory. This block fetches the selected window,
// draws it into a vanilla <canvas> (no chart library — the plot is
// intentionally simple), and re-renders on each dashboard tick.
//
// Data shape from /api/stats/history:
//   { minutes, sample_interval_sec, samples: [{t_ms, used_bytes,
//     reserved_bytes, limit_bytes, running}, ...] }

const RAM_CHART_STATE = { minutes: 60, lastRender: 0 };

function ramChartRange() {
  const el = $("#ram-chart-range");
  const n = el ? Number(el.value) : 60;
  return Number.isFinite(n) && n > 0 ? n : 60;
}

async function refreshRamChart() {
  const card = $("#ram-chart-card");
  if (!card) return;
  const minutes = ramChartRange();
  RAM_CHART_STATE.minutes = minutes;
  let data;
  try {
    data = await api(`/api/stats/history?minutes=${minutes}`);
  } catch {
    return;   // silent — chart is best-effort like the stats bar
  }
  card.hidden = false;
  drawRamChart(data);
}

function drawRamChart(data) {
  const canvas = $("#ram-chart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  // Handle HiDPI: back the canvas with devicePixelRatio-scaled pixels
  // so lines stay crisp. Only resize the backing store when needed so we
  // don't churn the GPU on every 5s tick.
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 900;
  const cssH = canvas.clientHeight || 180;
  const needW = Math.round(cssW * dpr);
  const needH = Math.round(cssH * dpr);
  if (canvas.width !== needW || canvas.height !== needH) {
    canvas.width = needW;
    canvas.height = needH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const samples = (data && data.samples) || [];
  const sub = $("#ram-chart-sub");
  if (samples.length === 0) {
    if (sub) sub.textContent = `no samples yet in the last ${data && data.minutes || RAM_CHART_STATE.minutes} min`;
    // Draw the empty grid so the card doesn't look broken.
    drawChartFrame(ctx, cssW, cssH, RAM_CHART_STATE.minutes, 0, 1);
    return;
  }

  // Y-axis: use the container limit if we have one, else max observed.
  const limit = samples.reduce((m, s) => Math.max(m, s.limit_bytes || 0), 0);
  const maxObs = samples.reduce((m, s) => Math.max(m,
    s.used_bytes || 0, s.reserved_bytes || 0, s.limit_bytes || 0), 0);
  const yMax = limit > 0 ? limit : Math.max(1, maxObs * 1.1);
  const now = Date.now();
  const windowMs = RAM_CHART_STATE.minutes * 60_000;
  const xMin = now - windowMs;

  drawChartFrame(ctx, cssW, cssH, RAM_CHART_STATE.minutes, yMax, limit);

  const pad = { l: 52, r: 8, t: 8, b: 20 };
  const plotW = cssW - pad.l - pad.r;
  const plotH = cssH - pad.t - pad.b;
  const xOf = (t) => pad.l + ((t - xMin) / windowMs) * plotW;
  const yOf = (v) => pad.t + plotH - (v / yMax) * plotH;

  // Filled "used" line first (behind), then "reserved" line on top.
  const cs = getComputedStyle(document.documentElement);
  const cAccent   = cs.getPropertyValue("--accent").trim()   || "#4f8cff";
  const cWarn     = cs.getPropertyValue("--warn").trim()     || "#f5a524";
  const cTextDim  = cs.getPropertyValue("--text-dim").trim() || "#9aa3b2";

  // Fill under "used".
  ctx.beginPath();
  ctx.moveTo(xOf(samples[0].t_ms), pad.t + plotH);
  for (const s of samples) ctx.lineTo(xOf(s.t_ms), yOf(s.used_bytes || 0));
  ctx.lineTo(xOf(samples[samples.length - 1].t_ms), pad.t + plotH);
  ctx.closePath();
  ctx.fillStyle = hexAlpha(cAccent, 0.16);
  ctx.fill();

  // Used line
  strokePath(ctx, samples, xOf, yOf, "used_bytes", cAccent, 1.75);
  // Reserved line (dashed so it visually differs from used)
  ctx.save();
  ctx.setLineDash([4, 3]);
  strokePath(ctx, samples, xOf, yOf, "reserved_bytes", cWarn, 1.5);
  ctx.restore();

  // Sub-caption: latest values.
  const latest = samples[samples.length - 1];
  if (sub) {
    sub.textContent =
      `Now: ${fmtBytes(latest.used_bytes || 0)} used · `
      + `${fmtBytes(latest.reserved_bytes || 0)} reserved`
      + (latest.limit_bytes ? ` / ${fmtBytes(latest.limit_bytes)} limit` : "")
      + ` · ${samples.length} samples over last ${RAM_CHART_STATE.minutes} min`;
  }
}

function drawChartFrame(ctx, w, h, minutes, yMax, limit) {
  const pad = { l: 52, r: 8, t: 8, b: 20 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const cs = getComputedStyle(document.documentElement);
  const cBorder  = cs.getPropertyValue("--border").trim()   || "#2a2f3a";
  const cTextDim = cs.getPropertyValue("--text-dim").trim() || "#9aa3b2";

  // Horizontal gridlines at 0/25/50/75/100% of yMax.
  ctx.strokeStyle = cBorder;
  ctx.lineWidth = 1;
  ctx.font = "10px system-ui, sans-serif";
  ctx.fillStyle = cTextDim;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + plotW, y);
    ctx.stroke();
    const val = yMax * (1 - i / 4);
    ctx.fillText(fmtBytesShort(val), pad.l - 4, y);
  }

  // Limit line — a solid horizontal line if a limit is known and it fits
  // within yMax.
  if (limit > 0 && limit <= yMax) {
    const y = pad.t + plotH - (limit / yMax) * plotH;
    ctx.save();
    ctx.strokeStyle = cTextDim;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + plotW, y);
    ctx.stroke();
    ctx.restore();
  }

  // X-axis ticks — 5 evenly spaced labels (oldest → now).
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let i = 0; i <= 4; i++) {
    const x = pad.l + (plotW * i) / 4;
    const ago = Math.round((minutes * (1 - i / 4)));
    const label = ago === 0 ? "now" : `-${ago}m`;
    ctx.fillText(label, x, pad.t + plotH + 4);
  }
}

function strokePath(ctx, samples, xOf, yOf, key, color, width) {
  ctx.beginPath();
  let started = false;
  for (const s of samples) {
    const v = s[key];
    if (v == null) continue;
    const x = xOf(s.t_ms);
    const y = yOf(v);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

function fmtBytesShort(n) {
  // Compact variant for axis labels (e.g. "3.2G").
  if (!n) return "0";
  const units = ["B", "K", "M", "G", "T"];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}${units[i]}`;
}

function hexAlpha(hex, alpha) {
  // #rrggbb -> rgba(r,g,b,alpha). Falls through unchanged for anything
  // exotic (rgb(), hsl(), etc.) — the fill just won't be translucent.
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// Re-render when the operator changes the timeframe.
document.addEventListener("DOMContentLoaded", () => {
  const sel = $("#ram-chart-range");
  if (sel) sel.addEventListener("change", () => refreshRamChart().catch(() => {}));
});

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
    const wd = r.watchdog;
    // Ready = the readiness probe has succeeded at least once since the
    // server went active. If the game type has no supported probe we
    // trust systemd and treat "active" as ready.
    const ready = !s.probe_supported || !!(wd && wd.ready);
    const chip = stateChip(s.active, s.sub, ready, !!s.probe_supported, wd, s);
    // "Stuck/slow start" = the unit is active but the readiness probe still
    // hasn't answered. That's the exact state where /diagnose earns its
    // keep (RAM frozen, no crash), so surface a Diagnose button on the card.
    const looksStuck = s.active === "active" && !!s.probe_supported && !ready;

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
    // the countdown to auto-shutdown. Suppressed while the server is
    // still starting — the "◐ starting" badge already tells the operator
    // there's no player data yet.
    //
    // pl === null while probe_ok is true means "readiness confirmed but
    // player count unavailable" (e.g. Satisfactory HealthCheck succeeded
    // but the admin_password needed for QueryServerState wasn't set).
    // Render a distinct hint chip so the operator knows exactly what to
    // fix without confusing it with "probe is still trying".
    let idleChip = "";
    if (d.idle_shutdown_min && s.active === "active" && wd && ready) {
      const pl = wd.players;
      if (!wd.probe_ok) {
        idleChip = `<span class="chip" title="Waiting for A2S/SLP/HTTPS probe response">👥 —</span>`;
      } else if (pl == null) {
        idleChip = `<span class="chip" title="Ready — player count needs passwords.admin_password in server YAML">👥 ?</span>`;
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

    // Install / job-status chip. Priority:
    //   1. Live install/update job → phase + percent (e.g. "downloading 42%")
    //   2. Never installed → "not installed" chip nudging the operator to
    //      open the Admin tab.
    // We deliberately don't surface "install failed" persistently; the
    // Admin tab is where the operator goes to see + fix that.
    let installChip = "";
    const job = r.job;
    if (job && !job.done) {
      const phase = job.phase || job.kind;
      const pct = Number.isFinite(job.percent) ? ` ${job.percent.toFixed(0)}%` : "";
      installChip = `<span class="chip chip-accent" title="${escape(job.kind)} in progress">⬇ ${escape(phase)}${pct}</span>`;
    } else if (job && job.done && !job.ok && (Date.now() / 1000 - (job.elapsed_sec ? 0 : 0)) < 60) {
      // Recently-failed job — show a red chip so operator notices.
      installChip = `<span class="chip chip-err" title="${escape(job.error || 'install failed')}">✕ ${escape(job.kind)} failed</span>`;
    } else if (s.installed === false) {
      installChip = `<span class="chip chip-warn" title="Open the Admin tab and click Install / Reprovision">⚠ not installed</span>`;
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
        <span class="chip ${chip.cls}"${chip.title ? ` title="${escape(chip.title)}"` : ""}>${chip.label}</span>
        <span class="chip">:${d.port}</span>
        ${s.enabled === "enabled" ? '<span class="chip chip-accent">on boot</span>' : ''}
        ${s.console_available ? '<span class="chip">console</span>' : ''}
        ${accessChip}
        ${idleChip}
        ${wakeChip}
        ${installChip}
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
        ${looksStuck ? `<button class="btn btn-tiny btn-warn" data-diagnose="${d.name}" title="Active but not answering its readiness probe — find out why">🩺 Diagnose</button>` : ""}
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
  if (t.dataset.diagnose) {
    // Jump straight from a stuck card into the detail panel + verdict.
    ev.preventDefault();
    await openServer(t.dataset.diagnose);
    runDiagnose(t.dataset.diagnose);
    return;
  }
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

    // Wake whitelist — always visible on the Admin tab, but with a hint
    // when it's not currently enforced (either wake-on-demand is off, or
    // the server isn't a Minecraft server so the TCP-login-peek filter
    // doesn't apply).
    const wlEnforced = !!d.wake_on_demand
      && ["minecraft-java", "minecraft-forge"].includes(d.type);
    const wlHint = $("#admin-wl-inactive-hint");
    if (wlHint) wlHint.hidden = wlEnforced;
    const names = Array.isArray(d.wake_whitelist) ? d.wake_whitelist : [];
    $("#iw-wl-names").value = names.join("\n");
    $("#iw-wl-status").textContent = "";

    // Firewall panel — mode radio + optional IP allow list. Reads
    // whatever's in ServerDef.firewall; defaults to "lan" if the field
    // is missing on an older def.
    const fw = (d.firewall && typeof d.firewall === "object") ? d.firewall : {};
    const fwMode = ["lan", "public", "allowlist"].includes(fw.mode) ? fw.mode : "lan";
    const modeEl = $(`#fw-mode-${fwMode}`);
    if (modeEl) modeEl.checked = true;
    $("#fw-ips").value = Array.isArray(fw.allow_ips) ? fw.allow_ips.join("\n") : "";
    $("#fw-ips-row").hidden = (fwMode !== "allowlist");
    $("#fw-warning").hidden = (fwMode !== "public");
    // Small header label so the operator sees which port this applies to.
    const proto = ["minecraft-java", "minecraft-forge"].includes(d.type) ? "tcp" : "udp";
    $("#fw-port-label").textContent = `— port ${d.port}/${proto}`;
    $("#fw-status").textContent = "";

    // Stop-wait control: only relevant for handlers whose stop.sh is
    // manager-generated AND parameterized on stop_timeout_sec. Right now
    // that's just the two Minecraft handlers; the SteamCMD template still
    // has a fixed wait and custom servers ship their own scripts. We hide
    // the row rather than showing a control that silently no-ops.
    const stopEditable = ["minecraft-java", "minecraft-forge"].includes(d.type);
    const stopRow = $("#iw-stop-row");
    if (stopRow) stopRow.hidden = !stopEditable;
    if (stopEditable) {
      // Fall back to a sensible per-type default so the input isn't blank
      // when stop_timeout_sec has never been set on this def.
      const typeDefault = d.type === "minecraft-forge" ? 280 : 240;
      $("#iw-stop-sec").value = d.stop_timeout_sec || typeDefault;
      $("#iw-stop-status").textContent = "";
      $("#iw-stop-hint").hidden = true;
    }

    // Memory cap row — always shown. memory_mb is used by every handler:
    //   * minecraft-* → -Xms/-Xmx baked into start.sh + user_jvm_args.txt
    //   * steamcmd   → informational (game manages its own memory); the
    //                  pre-flight RAM check still uses it to prevent
    //                  overcommit when the operator hits Start
    $("#iw-mem-mb").value = d.memory_mb || 2048;
    $("#iw-mem-status").textContent = "";
    $("#iw-mem-hint").hidden = true;

    // Steam ID address-book table for this server. Loaded async so the
    // rest of the panel doesn't wait on a second HTTP hop.
    loadSteamIdPanel(d);
  } catch (e) {
    $("#iw-idle-status").textContent = "ERROR: " + e.message;
  }
}

async function _saveDefPatch(name, patch, statusEl) {
  statusEl.textContent = "saving…";
  try {
    const r = await api(`/api/servers/${name}`);
    const sd = Object.assign({}, r.def, patch);
    const resp = await api("/api/servers", { method: "POST", body: JSON.stringify(sd) });
    // Surface auto-restart feedback so the operator knows the running
    // game was cycled to pick up changes to port/wake_on_demand/etc.
    if (resp && resp.auto_restart && resp.auto_restart.attempted) {
      statusEl.textContent = resp.auto_restart.ok
        ? "✓ saved + restarted"
        : "✓ saved (restart FAILED — see server logs)";
    } else {
      statusEl.textContent = "✓ saved";
    }
    setTimeout(() => {
      if (statusEl.textContent.startsWith("✓")) statusEl.textContent = "";
    }, 3500);
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
    // Update the "not enforced" hint on the Admin tab's whitelist panel
    // in case wake was just toggled off.
    const wlEnforced = !!sd.wake_on_demand
      && ["minecraft-java", "minecraft-forge"].includes(sd.type);
    const wlHint = $("#admin-wl-inactive-hint");
    if (wlHint) wlHint.hidden = wlEnforced;
  }
});

// Update the Admin-tab whitelist "not enforced" hint live as the wake
// checkbox is clicked, so the operator sees the state without saving.
$("#iw-wake-enabled")?.addEventListener("change", () => {
  const hint = $("#admin-wl-inactive-hint");
  if (!hint || !IW_PREV_DEF) return;
  const wlEnforced = $("#iw-wake-enabled").checked
    && ["minecraft-java", "minecraft-forge"].includes(IW_PREV_DEF.type);
  hint.hidden = wlEnforced;
});

// Enter key in the number fields saves the corresponding row.
$("#iw-idle-min")?.addEventListener("keydown", (e) => { if (e.key === "Enter") $("#iw-save-idle").click(); });
$("#iw-wake-sec")?.addEventListener("keydown", (e) => { if (e.key === "Enter") $("#iw-save-wake").click(); });
$("#iw-stop-sec")?.addEventListener("keydown", (e) => { if (e.key === "Enter") $("#iw-save-stop").click(); });

$("#iw-save-stop")?.addEventListener("click", async () => {
  if (!CURRENT) return;
  // Clamp to the same bound the server-side handler applies so the user
  // sees the corrected number in the input if they typed something absurd.
  const raw = parseInt($("#iw-stop-sec").value, 10);
  const clamped = Number.isFinite(raw) ? Math.min(285, Math.max(10, raw)) : 240;
  $("#iw-stop-sec").value = clamped;
  const prev = IW_PREV_DEF ? IW_PREV_DEF.stop_timeout_sec : null;
  const sd = await _saveDefPatch(CURRENT, { stop_timeout_sec: clamped }, $("#iw-stop-status"));
  if (sd) {
    IW_PREV_DEF = sd;
    // The value only takes effect after stop.sh is regenerated. Prompt
    // the operator to reinstall if the number actually changed.
    if (prev !== clamped) $("#iw-stop-hint").hidden = false;
  }
});

$("#iw-save-wl")?.addEventListener("click", async () => {
  if (!CURRENT) return;
  // Parse the textarea: one name per line, strip whitespace, drop blanks
  // and duplicates (case-insensitive dedupe, preserve first-seen casing).
  const raw = $("#iw-wl-names").value.split(/\r?\n/);
  const seen = new Set();
  const names = [];
  for (const line of raw) {
    const n = line.trim();
    if (!n) continue;
    const key = n.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(n);
  }
  // Reflect the cleaned list back so the operator sees the sanitised form.
  $("#iw-wl-names").value = names.join("\n");
  const sd = await _saveDefPatch(CURRENT, { wake_whitelist: names }, $("#iw-wl-status"));
  if (sd) IW_PREV_DEF = sd;
});

// Memory cap Save — clamps to the input's min, otherwise just persists.
// Takes effect after Install (regenerates start.sh with new -Xmx) + Restart.
$("#iw-save-mem")?.addEventListener("click", async () => {
  if (!CURRENT) return;
  const raw = parseInt($("#iw-mem-mb").value, 10);
  if (!Number.isFinite(raw) || raw < 512) {
    $("#iw-mem-status").textContent = "ERROR: memory_mb must be >= 512";
    return;
  }
  // Clamp to reasonable ceiling so a typo can't set 999999 MB.
  const mb = Math.min(raw, 262144);
  $("#iw-mem-mb").value = mb;
  const prev = IW_PREV_DEF ? IW_PREV_DEF.memory_mb : null;
  const sd = await _saveDefPatch(CURRENT, { memory_mb: mb }, $("#iw-mem-status"));
  if (sd) {
    IW_PREV_DEF = sd;
    if (prev !== mb) $("#iw-mem-hint").hidden = false;
  }
});
$("#iw-mem-mb")?.addEventListener("keydown", (e) => { if (e.key === "Enter") $("#iw-save-mem").click(); });

// ---------- Steam ID address book + per-server allowlist ----------
//
// The address book is a global JSON store served by /api/steam-profiles
// (see app/steam_profiles.py). This module fetches it once per panel
// load and renders a table where each row shows: display name, SteamID,
// and a Remove button. Add-row inputs let the operator paste a new ID +
// optional name; "Fetch name" tries the Steam public XML endpoint.
//
// Removing a row removes the ID from *this server's* allowed_steamids —
// it leaves the display name in the address book so a re-add is fast.

const STEAM_PROFILES = { data: {}, loaded: false };

async function _refreshSteamProfiles() {
  try {
    const r = await api("/api/steam-profiles");
    STEAM_PROFILES.data = (r && r.profiles) || {};
    STEAM_PROFILES.loaded = true;
  } catch {
    STEAM_PROFILES.data = {};
    STEAM_PROFILES.loaded = false;
  }
}

async function loadSteamIdPanel(d) {
  const body = $("#sid-list-body");
  if (!body) return;
  const note = $("#sid-note");
  const inactiveHint = $("#sid-inactive-hint");

  const access = d.access || {};
  const ids = Array.isArray(access.allowed_steamids) ? access.allowed_steamids.slice() : [];
  const enforced = access.mode === "steamid_allowlist";
  if (note) note.textContent = enforced
    ? `— enforced (${ids.length} allowed)`
    : `— not enforced by access.mode`;
  if (inactiveHint) inactiveHint.hidden = enforced;

  await _refreshSteamProfiles();

  body.innerHTML = "";
  if (ids.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="3" class="muted">No SteamIDs on this server yet.</td>`;
    body.appendChild(tr);
  } else {
    for (const sid of ids) {
      const name = STEAM_PROFILES.data[sid] || "";
      const tr = document.createElement("tr");
      const nameCell = name
        ? `<td class="sid-name">${escape(name)}</td>`
        : `<td class="sid-name muted"><em>(no name)</em></td>`;
      tr.innerHTML =
        nameCell +
        `<td class="sid-id">${escape(sid)}</td>` +
        `<td class="sid-actions">
           <button class="btn btn-tiny sid-rename" data-sid="${escape(sid)}"
                   title="Set / update the display name">Rename</button>
           <button class="btn btn-tiny btn-danger sid-remove" data-sid="${escape(sid)}"
                   title="Remove this SteamID from the server allowlist">Remove</button>
         </td>`;
      body.appendChild(tr);
    }
  }

  // Wire per-row buttons every render (elements are new each time).
  body.querySelectorAll(".sid-remove").forEach((btn) => {
    btn.addEventListener("click", () => _sidRemove(btn.dataset.sid));
  });
  body.querySelectorAll(".sid-rename").forEach((btn) => {
    btn.addEventListener("click", () => _sidRename(btn.dataset.sid));
  });
}

async function _sidRemove(sid) {
  if (!CURRENT || !sid) return;
  if (!confirm(`Remove ${sid} from this server's Steam ID allowlist? (address book entry is kept)`)) return;
  const r = await api(`/api/servers/${CURRENT}`);
  const ids = ((r.def || {}).access?.allowed_steamids || []).filter((s) => s !== sid);
  const patch = { access: Object.assign({}, r.def.access, { allowed_steamids: ids }) };
  const sd = await _saveDefPatch(CURRENT, patch, $("#sid-status"));
  if (sd) { IW_PREV_DEF = sd; loadSteamIdPanel(sd); }
}

async function _sidRename(sid) {
  const current = STEAM_PROFILES.data[sid] || "";
  const next = prompt(`Display name for ${sid}\n(empty removes the address-book entry)`, current);
  if (next === null) return;
  const status = $("#sid-status");
  status.textContent = "saving…";
  try {
    await api("/api/steam-profiles", {
      method: "POST",
      body: JSON.stringify({ steamid: sid, name: next.trim() }),
    });
    status.textContent = "✓ saved";
    setTimeout(() => { if (status.textContent === "✓ saved") status.textContent = ""; }, 2000);
    await _refreshSteamProfiles();
    if (IW_PREV_DEF) loadSteamIdPanel(IW_PREV_DEF);
  } catch (e) {
    status.textContent = "ERROR: " + e.message;
  }
}

$("#sid-lookup")?.addEventListener("click", async () => {
  const sid = $("#sid-add-id").value.trim();
  const status = $("#sid-status");
  if (!/^7656119\d{10}$/.test(sid)) {
    status.textContent = "ERROR: enter a valid 17-digit SteamID64 first";
    return;
  }
  status.textContent = "looking up…";
  try {
    const r = await api(`/api/steam-profiles/lookup?steamid=${encodeURIComponent(sid)}`);
    if (r.name) {
      $("#sid-add-name").value = r.name;
      status.textContent = `✓ Steam says "${r.name}"`;
    } else {
      status.textContent = "no public name found (private profile or offline)";
    }
  } catch (e) {
    status.textContent = "ERROR: " + e.message;
  }
});

$("#sid-add")?.addEventListener("click", async () => {
  if (!CURRENT) return;
  const sid = $("#sid-add-id").value.trim();
  const name = $("#sid-add-name").value.trim();
  const status = $("#sid-status");
  if (!/^7656119\d{10}$/.test(sid)) {
    status.textContent = "ERROR: SteamID must be 17 digits starting with 7656119";
    return;
  }
  status.textContent = "adding…";
  try {
    // Save the address-book entry FIRST so the row that appears next has
    // the name filled in without a re-render race.
    if (name) {
      await api("/api/steam-profiles", {
        method: "POST",
        body: JSON.stringify({ steamid: sid, name }),
      });
    }
    // Merge into the def's allowed_steamids without duplicating.
    const r = await api(`/api/servers/${CURRENT}`);
    const existing = (r.def && r.def.access && r.def.access.allowed_steamids) || [];
    if (existing.includes(sid)) {
      status.textContent = "already on this server's allowlist";
    } else {
      const patch = {
        access: Object.assign({}, r.def.access, {
          allowed_steamids: [...existing, sid],
        }),
      };
      const sd = await _saveDefPatch(CURRENT, patch, status);
      if (sd) IW_PREV_DEF = sd;
    }
    $("#sid-add-id").value = "";
    $("#sid-add-name").value = "";
    if (IW_PREV_DEF) loadSteamIdPanel(IW_PREV_DEF);
  } catch (e) {
    status.textContent = "ERROR: " + e.message;
  }
});

// Firewall panel: reveal/hide the IP textarea + warning based on mode,
// and let the operator save the mode + IP list. The backend applies UFW
// rules synchronously on save; the response includes a firewall status
// object we render into the status line.
$$('input[name="fw-mode"]').forEach((r) => {
  r.addEventListener("change", () => {
    const mode = document.querySelector('input[name="fw-mode"]:checked')?.value;
    $("#fw-ips-row").hidden = (mode !== "allowlist");
    $("#fw-warning").hidden = (mode !== "public");
  });
});

$("#fw-save")?.addEventListener("click", async () => {
  if (!CURRENT) return;
  const mode = document.querySelector('input[name="fw-mode"]:checked')?.value || "lan";
  // Sanitize IP list: strip whitespace, dedupe, drop blanks. We let the
  // server-side pydantic validator reject anything that isn't a valid
  // IP or CIDR; failed saves show up in fw-status.
  const raw = $("#fw-ips").value.split(/\r?\n/);
  const seen = new Set();
  const ips = [];
  for (const line of raw) {
    const s = line.trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    ips.push(s);
  }
  $("#fw-ips").value = ips.join("\n");

  const statusEl = $("#fw-status");
  statusEl.textContent = "applying…";
  try {
    // Merge into the existing def so we don't clobber other fields.
    const r = await api(`/api/servers/${CURRENT}`);
    const sd = Object.assign({}, r.def, {
      firewall: { mode, allow_ips: mode === "allowlist" ? ips : [] },
    });
    const resp = await api("/api/servers", {
      method: "POST", body: JSON.stringify(sd),
    });
    IW_PREV_DEF = sd;
    const fw = resp.firewall || {};
    if (fw.skipped) {
      statusEl.textContent = "⚠ ufw not installed on host — def saved but no rules applied";
    } else if (fw.ok === false) {
      statusEl.textContent = "ERROR: " + (fw.detail || "unknown");
    } else {
      const n = fw.rules_added || 0;
      statusEl.textContent = `✓ applied (${n} rule${n === 1 ? "" : "s"})`;
      setTimeout(() => {
        if (statusEl.textContent.startsWith("✓")) statusEl.textContent = "";
      }, 3000);
    }
    refreshServers();
  } catch (e) {
    statusEl.textContent = "ERROR: " + e.message;
  }
});

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
  if (name === "control") {
    // Console log + input now live at the bottom of Control. Fire the
    // initial fetch and start the auto-refresh follower.
    loadConsoleLog();
    if ($("#console-follow")?.checked) CONSOLE_TIMER = setInterval(loadConsoleLog, 2000);
  }
  if (name === "files") listFiles();
  if (name === "backups") loadBackups();
  if (name === "def") loadDef();
  if (name === "git") loadGit();
  // Admin tab has no async load of its own — the shared idle/wake panel
  // (loaded when the server detail opens) already populates its whitelist
  // + SteamID sections.
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
  if (action === "diagnose") {
    await runDiagnose(CURRENT);
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

// ---------- Stuck-start diagnosis ----------
// Calls /api/servers/<name>/diagnose (kernel wchan + process State + open
// FDs, plus the keyctl-syscall and world_dir-mount host-blocker checks)
// and renders ONE ranked verdict. This is the anti-"guess for 5 hours"
// tool: when a server sits at "◐ starting" with RAM frozen and no crash,
// it names the exact blocking layer and the exact fix instead of making
// the operator correlate /proc fields by hand.
async function runDiagnose(name) {
  const panel = $("#diagnose-panel");
  if (!panel) return;
  panel.hidden = false;
  panel.innerHTML = `<p class="muted">Diagnosing <code>${escape(name)}</code>…</p>`;
  try {
    const d = await api(`/api/servers/${name}/diagnose`);
    if (!d.ok) {
      panel.innerHTML = `<p class="form-error">${escape(d.detail || d.reason || "diagnose failed")}</p>`;
      return;
    }
    const v = d.verdict || {};
    const causes = v.causes || [];
    const confCls = { high: "chip-err", medium: "chip-warn", low: "chip-muted" };
    const causeHtml = causes.length
      ? causes.map((c, i) => `
          <div class="diag-cause${i === 0 ? " diag-cause-top" : ""}">
            <div class="diag-cause-head">
              <span class="chip ${confCls[c.confidence] || "chip-muted"}">${escape(c.confidence || "?")}</span>
              <strong>${escape(c.cause)}</strong>
            </div>
            <p class="small">${escape(c.why || "")}</p>
            ${c.fix ? `<pre class="diag-fix">${escape(c.fix)}</pre>` : ""}
          </div>`).join("")
      : `<p class="muted">${escape(v.summary || "No blocking cause detected.")}</p>`;
    const chk = v.checks || {};
    panel.innerHTML = `
      <div class="diag-verdict">
        <div class="diag-title">
          <strong>Diagnosis:</strong> ${escape(v.summary || "-")}
          ${v.in_disk_sleep ? '<span class="chip chip-err" title="Uninterruptible I/O sleep — the NFS/disk fingerprint">State D</span>' : ""}
        </div>
        ${causeHtml}
        <details class="diag-raw">
          <summary>Raw process introspection (game PID ${escape(String(d.game_pid))})</summary>
          <table class="kv small">
            <tr><td>wchan</td><td><code>${escape(d.wchan || "-")}</code></td></tr>
            <tr><td>comm</td><td><code>${escape(d.comm || "-")}</code></td></tr>
            <tr><td>keyctl</td><td><code>${chk.keyctl_available ? "available" : "BLOCKED (" + escape(chk.keyctl_error || "?") + ")"}</code></td></tr>
            <tr><td>world_dir fs</td><td><code>${escape(chk.world_dir_fstype || "-")}${chk.world_dir_networked ? " ⚠ networked" : ""}</code></td></tr>
          </table>
          <pre class="diag-pre">${escape(d.status || "")}</pre>
          <pre class="diag-pre">${escape((d.thread_wchans || []).join("\n"))}</pre>
          <pre class="diag-pre">${escape((d.open_fds || []).join("\n"))}</pre>
        </details>
      </div>`;
  } catch (e) {
    panel.innerHTML = `<p class="form-error">Diagnose failed: ${escape(e.message)}</p>`;
  }
}

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

// Console — prefer the game process's own log (Minecraft's logs/latest.log
// via /game-log) so operators see real events like "Player X joined the
// game", chat, and mod init lines. Falls back to the manager journal for
// server types where no game log path is defined server-side. Cached per
// server to avoid re-probing /game-log every 2s tick.
let CONSOLE_TIMER = null;
const CONSOLE_SOURCE = new Map();   // name -> "game-log" | "logs"

async function loadConsoleLog() {
  const n = $("#console-lines").value || 120;
  const el = $("#console-log-out");
  const srcLabel = $("#console-source");
  let source = CONSOLE_SOURCE.get(CURRENT);

  const fetchSource = async (kind) => {
    const path = kind === "game-log" ? "game-log" : "logs";
    return api(`/api/servers/${CURRENT}/${path}?lines=${encodeURIComponent(n)}`);
  };

  try {
    let txt;
    if (source === "logs") {
      txt = await fetchSource("logs");
    } else {
      // First try or previously-successful game-log path.
      try {
        txt = await fetchSource("game-log");
        source = "game-log";
      } catch (e) {
        // 404 → this server type has no game log. Remember that so we
        // don't hammer /game-log every 2s.
        if (String(e.message || e).includes("404")) {
          source = "logs";
          txt = await fetchSource("logs");
        } else {
          throw e;
        }
      }
      CONSOLE_SOURCE.set(CURRENT, source);
    }
    if (srcLabel) {
      srcLabel.textContent = source === "game-log"
        ? "source: game console"
        : "source: systemd journal";
    }
    const wasAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
    el.textContent = txt;
    if (wasAtBottom) el.scrollTop = el.scrollHeight;
  } catch (e) {
    el.textContent = "ERROR: " + e.message;
  }
}
$("#console-refresh")?.addEventListener("click", loadConsoleLog);
$("#console-follow")?.addEventListener("change", (ev) => {
  clearInterval(CONSOLE_TIMER); CONSOLE_TIMER = null;
  if (ev.target.checked) CONSOLE_TIMER = setInterval(loadConsoleLog, 2000);
});

// Diagnose stuck process — reads /proc/<PID>/wchan, kernel stack, open fds,
// per-thread wchans for the game binary under gamesrv@<name>.service. This
// is the button to press when the card shows "starting" forever and the
// console output has been silent past "Running ... on :PORT". The kernel
// tells us EXACTLY which function the process is blocked in.
$("#diagnose-stuck")?.addEventListener("click", async () => {
  const out = $("#diagnose-out");
  out.hidden = false;
  out.textContent = "reading /proc...";
  try {
    const d = await api(`/api/servers/${CURRENT}/diagnose`);
    if (!d.ok) {
      out.textContent = `diagnose failed: ${d.reason || "unknown"}\n${d.detail || ""}`;
      return;
    }
    const lines = [
      `=== Stuck-process diagnosis for ${d.server} ===`,
      `unit_active:       ${d.unit_active}`,
      `systemd MainPID:   ${d.systemd_main_pid}`,
      `game PID:          ${d.game_pid}   (comm: ${d.comm})`,
      ``,
      `Main thread wchan: ${d.wchan || "(empty)"}`,
      `HINT: ${d.hint || "(no hint)"}`,
      ``,
      `--- /proc/${d.game_pid}/status (selected fields) ---`,
      d.status || "(empty)",
      ``,
      `--- /proc/${d.game_pid}/stack (kernel call stack) ---`,
      (d.kernel_stack || "(empty)").trim(),
      ``,
      `--- Thread wchans (first ~15) ---`,
      (d.thread_wchans || []).join("\n") || "(none)",
      ``,
      `--- Open file descriptors (first ~40) ---`,
      (d.open_fds || []).join("\n") || "(none)",
    ];
    out.textContent = lines.join("\n");
  } catch (e) {
    out.textContent = "diagnose ERROR: " + e.message;
  }
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
        // Show the Edit button only for files that look like text and
        // aren't huge. This is a purely UX gate — the server still refuses
        // anything absurd.
        const editable = _isEditableText(r.name, r.size);
        const editBtn = editable
          ? `<button class="btn btn-tiny" data-edit="${escape(full)}">edit</button>`
          : "";
        tr.innerHTML = `<td>${escape(r.name)}</td><td>${fmtBytes(r.size)}</td>
          <td>${fmtTime(r.mtime)}</td>
          <td>
            ${editBtn}
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

// ---------- File editor ----------
//
// Cheap Files-tab editor for the small config files (Game.ini, server.env,
// server.properties, whitelist.json, etc.) an operator constantly needs to
// tweak. Anything that looks like text and is under ~512 KB gets an Edit
// button; the modal fetches with the existing /files/download endpoint and
// saves with /files (overwrite=true).

const _EDITABLE_EXT_RE =
  /\.(txt|ini|cfg|conf|env|json|jsonc|yml|yaml|toml|properties|xml|md|log|sh|py|lua|rb|js|css|html|htm|service|list)$/i;
const _EDITABLE_MAX_BYTES = 512 * 1024;

function _isEditableText(name, size) {
  if (size != null && size > _EDITABLE_MAX_BYTES) return false;
  if (_EDITABLE_EXT_RE.test(name)) return true;
  // Also allow the common no-extension file the manager writes.
  if (/^server\.env$/i.test(name)) return true;
  return false;
}

const EDITOR_STATE = { area: null, path: null };

async function openFileEditor(fullPath) {
  const area = $("#files-area").value;
  EDITOR_STATE.area = area;
  EDITOR_STATE.path = fullPath;
  $("#editor-title").textContent = `${area} / ${fullPath}`;
  $("#editor-status").textContent = "loading…";
  $("#editor-textarea").value = "";
  $("#editor-modal").hidden = false;
  try {
    const url = `/api/servers/${CURRENT}/files/download`
      + `?area=${encodeURIComponent(area)}&path=${encodeURIComponent(fullPath)}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const txt = await resp.text();
    $("#editor-textarea").value = txt;
    $("#editor-status").textContent = `${txt.length.toLocaleString()} chars`;
  } catch (e) {
    $("#editor-status").textContent = "ERROR: " + e.message;
  }
}

async function saveFileEditor() {
  if (!EDITOR_STATE.path) return;
  const statusEl = $("#editor-status");
  statusEl.textContent = "saving…";
  try {
    const txt = $("#editor-textarea").value;
    // Build a synthetic File so the server-side upload path is unchanged.
    // Type is text/plain — extension-driven decisions live on the client.
    const filename = EDITOR_STATE.path.split("/").pop();
    const blob = new File([txt], filename, { type: "text/plain" });
    const fd = new FormData();
    fd.append("file", blob);
    fd.append("area", EDITOR_STATE.area);
    fd.append("path", EDITOR_STATE.path);
    fd.append("overwrite", "true");
    const r = await api(`/api/servers/${CURRENT}/files`, { method: "POST", body: fd });
    statusEl.textContent = `✓ saved (${r.bytes} bytes at ${r.saved || EDITOR_STATE.path})`;
    setTimeout(() => { $("#editor-modal").hidden = true; listFiles(); }, 900);
  } catch (e) {
    statusEl.textContent = "ERROR: " + e.message;
  }
}

$("#editor-save")?.addEventListener("click", saveFileEditor);
$("#editor-cancel")?.addEventListener("click", () => { $("#editor-modal").hidden = true; });
// Ctrl+S saves; Escape closes.
document.addEventListener("keydown", (ev) => {
  if ($("#editor-modal")?.hidden) return;
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
    ev.preventDefault();
    saveFileEditor();
  } else if (ev.key === "Escape") {
    $("#editor-modal").hidden = true;
  }
});

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
  } else if (t.dataset.edit && CURRENT) {
    openFileEditor(t.dataset.edit);
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
      const resp = await uploadSingle(it.file, it.relPath, { rowId });
      // Show the resolved absolute path so the operator can see exactly
      // where the file landed on the LXC. Previous behavior said "uploaded"
      // with no destination, so files uploaded to the wrong area/subdir
      // looked successful but the game never saw them.
      const saved = (resp && resp.saved) ? resp.saved : "uploaded";
      setRowResult(rowId, "ok", saved);
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
    // Populate the git-backup panel from the current def (this endpoint
    // returns the full ServerDef under .def, including git_backup).
    await _loadGitBackupPanel();
  } catch (e) { $("#backups-out").textContent = "ERROR: " + e.message; }
}

async function _loadGitBackupPanel() {
  if (!CURRENT) return;
  const r = await api(`/api/servers/${CURRENT}`);
  const gb = (r.def && r.def.git_backup) || {};
  $("#gb-enabled").checked = !!gb.enabled;
  $("#gb-branch").value = gb.branch || "main";
  $("#gb-repo-url").value = gb.repo_url || "";
  $("#gb-token-env").value = gb.token_env || "";
  $("#gb-status").textContent = "";

  const chip = $("#gb-status-chip");
  if (gb.enabled) {
    chip.textContent = gb.repo_url ? "enabled" : "enabled · auto-provision on next push";
    chip.className = "chip chip-accent";
  } else {
    chip.textContent = "disabled";
    chip.className = "chip chip-muted";
  }

  const last = $("#gb-last-push");
  if (gb.last_push_at) {
    last.hidden = false;
    const shaShort = gb.last_push_sha ? gb.last_push_sha.slice(0, 7) : "?";
    last.innerHTML = `Last push: <code>${escape(shaShort)}</code> at ${escape(gb.last_push_at)}`;
  } else {
    last.hidden = true;
  }
}

$("#gb-save")?.addEventListener("click", async () => {
  if (!CURRENT) return;
  const statusEl = $("#gb-status");
  try {
    const r = await api(`/api/servers/${CURRENT}`);
    const gb = Object.assign({}, r.def.git_backup || {}, {
      enabled: $("#gb-enabled").checked,
      branch: ($("#gb-branch").value || "main").trim(),
      repo_url: $("#gb-repo-url").value.trim(),
      token_env: $("#gb-token-env").value.trim(),
    });
    const sd = Object.assign({}, r.def, { git_backup: gb });
    await api("/api/servers", { method: "POST", body: JSON.stringify(sd) });
    statusEl.textContent = "✓ saved";
    setTimeout(() => { if (statusEl.textContent === "✓ saved") statusEl.textContent = ""; }, 2000);
    _loadGitBackupPanel();
  } catch (e) {
    statusEl.textContent = "ERROR: " + e.message;
  }
});

$("#gb-push")?.addEventListener("click", async () => {
  if (!CURRENT) return;
  const statusEl = $("#gb-status");
  statusEl.textContent = "pushing… (may take a bit on first run)";
  try {
    const r = await api(`/api/servers/${CURRENT}/git-backup/push`, {
      method: "POST", body: JSON.stringify({}),
    });
    const parts = [];
    if (r.auto_created) parts.push("repo auto-created");
    parts.push(r.committed ? "new snapshot(s) committed" : "no new snapshots");
    parts.push(`branch=${r.branch}`);
    if (r.sha) parts.push(`sha=${r.sha.slice(0, 7)}`);
    statusEl.textContent = "✓ " + parts.join(" · ");
    _loadGitBackupPanel();
  } catch (e) {
    statusEl.textContent = "ERROR: " + e.message;
  }
});
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
  // Defense in depth: some browsers restore checkbox state via autofill
  // even after form.reset(). Wake-on-demand is intentionally opt-in —
  // silently enabling it flips the game's bind port (public → port+10000)
  // and inserts a wake-proxy in the traffic path, which is surprising
  // for a first-time deploy. Force it off on every modal open.
  $("#f-wake-on-demand").checked = false;
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

  // Smart routing: if the operator queued a .sav file and hasn't hand-set
  // the destination, auto-target the game's real save directory. This is
  // the single most common footgun — save files uploaded to install_dir
  // are lost as far as the game is concerned (Satisfactory reads from
  // ".config/Epic/FactoryGame/Saved/SaveGames/server", which the manager
  // symlinks to world_dir). Setting Area=world + Save under=SaveGames/server
  // is the right target for the games we know about today.
  const hasSav = initFiles.some((it) => /\.sav$/i.test(it.relPath));
  const areaEl = $("#init-upload-area");
  const pathEl = $("#init-upload-path");
  const hintEl = $("#init-file-hint");
  if (hasSav && areaEl && pathEl) {
    // Only auto-set if the operator hasn't customised them. We record the
    // most-recent auto value in a data attribute so a subsequent auto-set
    // doesn't clobber an intentional hand edit.
    const priorAutoArea = areaEl.dataset.autoSet || "";
    const priorAutoPath = pathEl.dataset.autoSet || "";
    if (areaEl.value === "" || areaEl.value === "install" || areaEl.value === priorAutoArea) {
      areaEl.value = "world";
      areaEl.dataset.autoSet = "world";
    }
    if (pathEl.value === "" || pathEl.value === priorAutoPath) {
      pathEl.value = "SaveGames/server";
      pathEl.dataset.autoSet = "SaveGames/server";
    }
    if (hintEl) {
      hintEl.hidden = false;
      hintEl.innerHTML =
        `<strong>Auto-routing:</strong> Detected a <code>.sav</code> — set Area to `
        + `<code>world_dir</code> and Save under to <code>SaveGames/server</code>. `
        + `Override the fields above if this isn't right for your game.`;
    }
  } else if (hintEl) {
    hintEl.hidden = true;
  }
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

  let createResp;
  try {
    createResp = await api("/api/servers", { method: "POST", body: JSON.stringify(sd) });
  } catch (e) {
    showFormError("Create failed: " + e.message);
    return;
  }

  // Surface firewall reconcile status. reconcile_server() is best-effort
  // (UFW missing, sudoers not wired, rule parse error) and its result is
  // returned in the POST response but was previously discarded. If it
  // failed OR skipped, warn the operator — otherwise the port is silently
  // closed and connections just time out with no clue why.
  try {
    const fw = createResp?.firewall;
    if (fw && !fw.ok) {
      alert(
        `Server '${sd.name}' saved, but the firewall did not open its port ` +
        `automatically:\n\n${fw.detail || "(no detail)"}\n\n` +
        `Fix by running on the LXC:\n` +
        `  cd /opt/gamesrv && sudo bash scripts/ufw-setup.sh\n\n` +
        `Then re-save the server definition to trigger a fresh reconcile.`
      );
    } else if (fw && fw.skipped) {
      console.warn(`firewall reconcile skipped for ${sd.name}: ${fw.detail}`);
    }
  } catch (_) { /* non-fatal */ }

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
          // Show the resolved server path so the operator immediately
          // sees WHERE the file landed. For an archive extract we don't
          // get a single path back, so keep the files-written summary.
          li.querySelector(".init-status").textContent =
            it.kind === "archive"
              ? `${r.files_written || 0} files extracted`
              : (r.saved || "ok");
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

  // Auto-run Install for SteamCMD servers. Without this, a new user had
  // to hunt for the Install button on the Control tab and click it —
  // meanwhile every other step (define, upload, start) is at their
  // fingertips. Install for SteamCMD games is a required prerequisite
  // for Start to do anything useful (start.sh points at binaries that
  // don't exist yet), so kicking it off automatically matches the mental
  // model "Create Server → play". The install job is async and streamed
  // as a progress bar on the Control tab — the user can walk away or
  // watch, and no other action is needed until it completes.
  //
  // Skipped for: minecraft-java/forge (require the operator to upload a
  // jar or Forge tree first — auto-install would just print a "no jar
  // found" message), custom (operator owns start.sh entirely).
  if (sd.type === "steamcmd") {
    try {
      // startJob uses CURRENT (the server we just openServer'd). Kick
      // it off but don't await — the polling loop keeps the progress
      // bar live even if the user tabs away.
      startJob("install", `/api/servers/${sd.name}/install`);
    } catch (e) {
      console.warn("auto-install trigger failed:", e);
    }
  }
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
