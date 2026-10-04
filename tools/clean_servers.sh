#!/usr/bin/env bash
# end every REAL grove server/supervisor — by process-group, whole family,
# never this session's own calls (its group is excluded).
python3 - <<'EOF'
import os, signal, subprocess

rows = []
for line in subprocess.run(["ps", "-e", "-o", "pid=,ppid=,pgid=,cmd="],
                           capture_output=True, text=True).stdout.splitlines():
    pid, _, rest = line.strip().partition(" ")
    ppid, _, rest = rest.strip().partition(" ")
    pgid, _, cmd = rest.strip().partition(" ")
    try:
        rows.append((int(pid), int(ppid), int(pgid), cmd))
    except ValueError:
        continue

runners = {p for p, _pp, _g, c in rows
           if c.startswith("python3 -m grove ")}
groups = {g for p, _pp, g, _c in rows if p in runners}
mine = os.getpgrp()
ended = []
for g in sorted(groups - {mine}):
    try:
        os.killpg(g, signal.SIGKILL)
        ended.append(g)
    except (ProcessLookupError, PermissionError):
        pass
print(f"ended {len(ended)} grove family/group(s): {ended}")
EOF