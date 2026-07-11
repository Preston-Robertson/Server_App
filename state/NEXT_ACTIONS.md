# Next Actions
<!-- Ordered checklist. Agents: check off items as you complete them, add new ones at the bottom. -->

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
