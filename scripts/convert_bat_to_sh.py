#!/usr/bin/env python3
"""convert_bat_to_sh.py — best-effort .bat → .sh converter for game launchers.

Most game-server .bat files are one-liners like:
    java -Xmx6G -jar server.jar nogui
    PalServer.exe -port=8211 -useperfthreads

This script translates the common patterns so `install` on a `custom` type
can accept a Windows-shipped launcher. Non-trivial cases still need manual
review — the script prints a WARNING when it hits something it can't map.

Usage:
    python3 scripts/convert_bat_to_sh.py path/to/start.bat > start.sh
"""
from __future__ import annotations

import re
import sys
from pathlib import Path


def convert(bat_text: str) -> str:
    out = ["#!/usr/bin/env bash", "set -euo pipefail",
           'cd "$(dirname "$0")"', ""]
    warned = False
    for raw in bat_text.splitlines():
        line = raw.strip()
        if not line or line.startswith("::") or line.lower().startswith("rem"):
            continue
        if line.lower().startswith("@echo"):
            continue
        if line.lower().startswith("pause"):
            continue
        if line.lower().startswith("title "):
            continue

        # %VAR% -> "$VAR"
        line = re.sub(r"%([A-Za-z_][A-Za-z0-9_]*)%", r'"${\1}"', line)
        # SET FOO=bar -> export FOO=bar
        m = re.match(r"(?i)^set\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if m:
            out.append(f'export {m.group(1)}="{m.group(2)}"')
            continue
        # .exe -> strip suffix (assume a linux binary of same name exists)
        line = re.sub(r"([\w.-]+)\.exe\b", r"./\1", line, flags=re.IGNORECASE)
        # Common launchers
        if re.match(r"(?i)^\s*(start\s+)?java\b", line):
            line = re.sub(r"(?i)^\s*start\s+", "", line)
            out.append(f"exec {line}")
            continue
        if re.match(r"(?i)^\s*\.?/?PalServer", line):
            out.append("exec ./PalServer.sh " + " ".join(line.split()[1:]))
            continue
        # Fallback: pass through, warn.
        if "\\" in line or line.lower().startswith(("call ", "goto ", "if ", "for ")):
            out.append(f"# TODO manual review: {raw}")
            warned = True
        else:
            out.append(line)

    if warned:
        print("WARNING: some lines need manual review — see TODO comments in output.",
              file=sys.stderr)
    return "\n".join(out) + "\n"


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    src = Path(sys.argv[1])
    sys.stdout.write(convert(src.read_text(encoding="utf-8", errors="replace")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
