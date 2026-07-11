# app/_context/perf.md
# Context summary for app/perf.py (72 lines).

## Purpose
Background RAM sampler: collects one lightweight snapshot of aggregate RAM usage every 15 seconds and keeps up to 24 hours of samples in a deque. Powers the dashboard's rolling RAM chart.

## Public API
- `perf_sampler = PerfSampler()` — module-level singleton
- `perf_sampler.start(sample_fn: SampleFn)` → None (called from `main.py` startup)
- `perf_sampler.stop()` → None
- `perf_sampler.history(minutes: int)` → `list[dict]` (samples with `t_ms >= now - minutes*60_000`)
- `SAMPLE_INTERVAL_SEC = 15`
- `RETENTION_SEC = 24 * 60 * 60` (24 hours)

## Called by
`app/main.py`: `_startup()` calls `perf_sampler.start(_collect_ram_sample)`. The `/api/stats` or a dedicated perf endpoint calls `perf_sampler.history()`.

## Calls / depends on
`threading`, `time`, `collections.deque`.

## Key invariants / gotchas
- **State is process-local**: manager restart resets all history. No on-disk store. Intentional tradeoff — no DB dependency.
- **`sample_fn`**: injected by `main.py` (`_collect_ram_sample`). The sampler doesn't know what it's sampling; it just calls the function and appends the result dict.
- **First sample delayed 5 seconds**: `self._stop.wait(5)` at the start of the loop so the first sample reflects steady state, not startup churn.
- **Exception swallowing**: a bad `sample_fn()` never kills the sampler thread; the chart just has a gap.
- **`history()` is cheap**: single lock + list comprehension over at most `_MAX_SAMPLES = 5760` items (24h × 4 samples/min).
- **Thread is a daemon**: manager shutdown kills it without explicit `stop()`.
- `_MAX_SAMPLES = RETENTION_SEC // SAMPLE_INTERVAL_SEC = 5760`.

## Common failure modes
- History always empty: `sample_fn` raises on every call (e.g., `/proc/meminfo` unreadable). No error surfaced — chart shows nothing.
- Duplicate sampler threads: `start()` returns early if a thread is already alive; safe to call multiple times.

## Where to change what
- Change sample interval: `SAMPLE_INTERVAL_SEC` constant.
- Change retention window: `RETENTION_SEC` constant.
- Change what's sampled: change the `_collect_ram_sample` function in `main.py` (not in this module).
