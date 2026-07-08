"""Background performance sampler.

Collects one lightweight snapshot of aggregate RAM usage every
``SAMPLE_INTERVAL_SEC`` seconds and keeps up to ``RETENTION_SEC`` worth
in memory. Powers the dashboard's rolling RAM chart.

State is process-local — a manager restart resets the history. That's an
intentional tradeoff: no on-disk store, no separate DB, no cross-process
serialization. If long-term retention is ever needed, wire this into
Prometheus / a TSDB rather than persisting the ring buffer.
"""
from __future__ import annotations

import threading
import time
from collections import deque
from typing import Callable, Optional


SAMPLE_INTERVAL_SEC = 15
# 24h of samples at the interval above. deque with maxlen is O(1) both ends.
RETENTION_SEC = 24 * 60 * 60
_MAX_SAMPLES = RETENTION_SEC // SAMPLE_INTERVAL_SEC


SampleFn = Callable[[], dict]


class PerfSampler:
    def __init__(self) -> None:
        self._samples: deque[dict] = deque(maxlen=_MAX_SAMPLES)
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._sample_fn: Optional[SampleFn] = None

    def start(self, sample_fn: SampleFn) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._sample_fn = sample_fn
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="gs-perf", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def history(self, minutes: int) -> list[dict]:
        """Return samples with t_ms >= now - minutes*60_000. Cheap: a
        single lock + list comprehension over at most _MAX_SAMPLES items."""
        cutoff_ms = int(time.time() * 1000) - minutes * 60_000
        with self._lock:
            return [s for s in self._samples if s["t_ms"] >= cutoff_ms]

    def _loop(self) -> None:
        # Small startup delay so the manager finishes booting and the
        # first sample reflects steady-state, not startup churn.
        self._stop.wait(5)
        while not self._stop.is_set():
            try:
                if self._sample_fn is not None:
                    s = self._sample_fn()
                    with self._lock:
                        self._samples.append(s)
            except Exception:
                # Never let a bad sample kill the sampler; the chart
                # will just have a gap.
                pass
            self._stop.wait(SAMPLE_INTERVAL_SEC)


perf_sampler = PerfSampler()
