"""In-memory background job registry for long-running install/update ops.

Each server has at most one active job at a time. Jobs run in daemon
threads; progress events are merged into the job state and read by the
dashboard via a polling endpoint.

This deliberately does NOT persist across manager restarts — if the manager
is restarted mid-install the SteamCMD child dies too. Recovering that would
mean daemonising steamcmd, which is overkill for a homelab dashboard.
"""
from __future__ import annotations

import threading
import time
import traceback
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Optional


ProgressCallback = Callable[[dict], None]
JobTarget = Callable[[ProgressCallback], list[str]]


@dataclass
class JobProgress:
    phase: str = ""            # human phase label (e.g. "downloading")
    percent: float = 0.0       # 0..100
    bytes_done: int = 0
    bytes_total: int = 0


@dataclass
class Job:
    id: str
    server: str
    kind: str                                 # "install" | "update"
    started_at: float
    finished_at: Optional[float] = None
    done: bool = False
    ok: bool = False
    error: str = ""
    progress: JobProgress = field(default_factory=JobProgress)
    tail: deque[str] = field(default_factory=lambda: deque(maxlen=200))
    messages: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "server": self.server,
            "kind": self.kind,
            "done": self.done,
            "ok": self.ok,
            "error": self.error,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "elapsed_sec": (self.finished_at or time.time()) - self.started_at,
            "progress": {
                "phase": self.progress.phase,
                "percent": round(self.progress.percent, 2),
                "bytes_done": self.progress.bytes_done,
                "bytes_total": self.progress.bytes_total,
            },
            "tail": list(self.tail),
            "messages": self.messages,
        }


class _Registry:
    def __init__(self) -> None:
        self._by_server: dict[str, Job] = {}
        self._lock = threading.Lock()

    def get(self, server: str) -> Optional[Job]:
        with self._lock:
            return self._by_server.get(server)

    def is_running(self, server: str) -> bool:
        j = self.get(server)
        return bool(j and not j.done)

    def start(self, server: str, kind: str, target: JobTarget) -> Job:
        with self._lock:
            existing = self._by_server.get(server)
            if existing and not existing.done:
                raise RuntimeError(
                    f"a {existing.kind} job is already running for {server}"
                )
            job = Job(
                id=uuid.uuid4().hex,
                server=server,
                kind=kind,
                started_at=time.time(),
            )
            self._by_server[server] = job

        def _cb(event: dict) -> None:
            # Called from the worker thread. Short critical sections + GIL
            # keep this safe against the reader thread pulling to_dict().
            with self._lock:
                if "phase" in event:
                    job.progress.phase = str(event["phase"])
                if "percent" in event:
                    try:
                        job.progress.percent = float(event["percent"])
                    except (TypeError, ValueError):
                        pass
                if "bytes_done" in event:
                    try:
                        job.progress.bytes_done = int(event["bytes_done"])
                    except (TypeError, ValueError):
                        pass
                if "bytes_total" in event:
                    try:
                        job.progress.bytes_total = int(event["bytes_total"])
                    except (TypeError, ValueError):
                        pass
                if "line" in event:
                    line = str(event["line"])
                    if line:
                        job.tail.append(line)

        def _run() -> None:
            try:
                msgs = target(_cb)
                with self._lock:
                    job.messages = list(msgs or [])
                    job.ok = True
                    if job.progress.percent < 100.0:
                        job.progress.percent = 100.0
                    if not job.progress.phase:
                        job.progress.phase = "complete"
            except Exception as e:
                with self._lock:
                    job.ok = False
                    job.error = f"{type(e).__name__}: {e}"
                    job.tail.append("ERROR: " + job.error)
                    last = traceback.format_exc().splitlines()[-1:]
                    for line in last:
                        job.tail.append(line)
            finally:
                with self._lock:
                    job.done = True
                    job.finished_at = time.time()

        threading.Thread(
            target=_run, name=f"job-{server}-{kind}", daemon=True
        ).start()
        return job


registry = _Registry()
