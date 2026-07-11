# app/_context/jobs.md
# Context summary for app/jobs.py (165 lines).

## Purpose
In-memory background job registry for long-running per-server operations (install, update, backup, restore). Each server has at most one active job at a time. Jobs run in daemon threads; progress events flow to the job record and are polled by the dashboard.

## Public API
- `registry = _Registry()` — module-level singleton
- `registry.get(server)` → `Optional[Job]`
- `registry.is_running(server)` → `bool`
- `registry.start(server, kind, target: JobTarget)` → `Job`
- **`Job`** dataclass: `id`, `server`, `kind`, `done`, `ok`, `error`, `started_at`, `finished_at`, `progress`, `tail` (deque[200]), `messages`
- `Job.to_dict()` → `dict` (serializable for the API)
- **`JobProgress`** dataclass: `phase`, `percent`, `bytes_done`, `bytes_total`
- `ProgressCallback = Callable[[dict], None]`
- `JobTarget = Callable[[ProgressCallback], list[str]]`

## Called by
`app/main.py` (install, update, backup, restore endpoints all call `registry.start()`). Job status endpoint calls `registry.get()`.

## Calls / depends on
`threading`, `uuid`, `time`, `traceback`, `sys`, `collections.deque`.

## Key invariants / gotchas
- **One job per server**: `registry.start()` raises `RuntimeError` if a job is already running for that server. The caller (main.py) should check `is_running()` or catch this.
- **No persistence**: all job state is in-memory. A manager restart kills in-progress jobs (the SteamCMD child dies too) and clears history.
- **`tail` is a deque(maxlen=200)**: last 200 output lines. Dashboard polls this for live progress display.
- **Progress callback is thread-safe**: uses `_lock` for all writes; `to_dict()` acquires the lock for reads.
- **Full traceback to stderr**: on exception, the full Python traceback goes to stderr (→ journal). Only a summary + last 6 tb lines go into `job.tail`.
- **`progress.percent` auto-set to 100.0** on successful completion if the target didn't set it.
- **`JobTarget` signature**: `target(progress_cb) -> list[str]`. The return value is stored as `job.messages`.

## Common failure modes
- Job never marks `done=True`: only possible if the worker thread is killed externally (manager restart). No timeout mechanism exists.
- `registry.start()` raises RuntimeError: previous job still running (maybe hung). No automatic cancellation.
- `tail` fills with garbage: only if the target calls `progress_cb({"line": ...})` excessively; capped at 200 entries.

## Where to change what
- Add a new job kind: implement a `JobTarget` function in the relevant module (e.g. `control.py`, `uploads.py`) and call `registry.start()` from `main.py`.
- Change tail history size: `deque(maxlen=200)` in `Job.__init__`.
- Add job persistence: would require a DB or file store; currently intentionally avoided.
