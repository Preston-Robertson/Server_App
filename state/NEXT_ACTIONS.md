# Next Actions
<!-- Ordered checklist. Agents: check off items as you complete them, add new ones at the bottom. -->

## Live blockers / decisions (2026-07-11 session)
- [ ] **Decide the public-firewall approach.** ufw cannot program netfilter in this unprivileged LXC, so
      `firewall.mode: public` never enforces from in-container (reconcile now surfaces the real ufw error —
      confirm it). Options: (a) make the CT privileged / add the capability so ufw works, or (b) manage the
      port at the Proxmox host firewall + router forward and have the manager stop implying in-container ufw
      enforces. Pick one; (b) is the low-risk manager-side change.
- [ ] **Confirm CGNAT** (WAN IP in router admin vs whatismyip.com / `100.64.0.0/10`). If carrier-NATed, public
      play needs a static IP or relay (Tailscale/ZeroTier/playit) — not a manager fix.
- [ ] **Confirm Satisfactory** via the now-surfaced FactoryGame.log (Diagnose → game log tail). Determine if
      the HTTPS API is genuinely failing or just emitting the usual SSL/SE_ENOTCONN noise; check query port bind.
- [ ] **Palworld player count + allowlist** require an ADMIN PASSWORD set + a Start (regenerates the seeded
      ini with RESTAPIEnabled). Verify player count shows + a non-allowlisted steamID is kicked within ~15s.

## Tech-debt backlog
- [ ] Fill in `app/_context/*.md` module summaries with accurate per-module details (verify against source and mark any speculative items)
- [ ] Populate `runbooks/troubleshooting/*.md` playbooks with real symptoms & fixes from incident history
- [ ] Decompose `app/main.py` into `app/routes/*.py` (Layer B refactor — see `docs/AGENT_REFACTOR_HANDOFF.md`)
- [ ] Decompose `app/wake_proxy.py` (1120 lines) into an `app/wake_proxy/` package
- [ ] Decompose `app/watchdog.py` (610 lines) — extract probing logic into `app/probes.py`
- [ ] Add `tests/` with a FastAPI smoke test (`TestClient` hitting `/healthz`) + config-loader test for each example server YAML
- [ ] Add structured logging conventions doc (`docs/LOGGING.md`) — current pattern is `print(..., file=sys.stderr)` with `[module]` prefix
- [ ] Verify `app/_context/main.md` endpoint table against actual `app/main.py` routes (grep for `@app.` and `@router.`)
- [ ] Populate `facts/paths.yaml` `state_dir` path with bootstrap.sh verification
- [ ] Add `app/_context/types.md` covering `app/types/` (base.py, steamcmd.py, minecraft_java.py, minecraft_forge.py, custom.py)
- [ ] Run baseline health check: start manager, hit `/healthz`, verify all subsystems initialize without error
