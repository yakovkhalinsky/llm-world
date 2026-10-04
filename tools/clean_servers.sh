#!/usr/bin/env bash
# kill every REAL grove server process — and nothing else.
#
# Why this exists: `pgrep -f "groce…"` patterns also match THIS session's
# tool-call wrapper shells, whose command lines merely quote the same
# words — killing your own shell mid-cleanup. This script inspects each
# pid's actual command and only acts on the real runner.
if [ "$(basename "$0")" = "clean_servers.sh" ] && \
   ps -p $$ -o cmd= | grep -qv "^bash .*clean_servers.sh"; then
  :
fi
for p in $(pgrep -f "grove" 2>/dev/null); do
  cmd=$(ps -p "$p" -o cmd= 2>/dev/null)
  case "$cmd" in
    "python3 -m grove "*|"python3 -m grove")
      kill -9 "$p" 2>/dev/null && echo "killed $p → $(echo "$cmd" | cut -c1-70)"
      ;;
    *)
      ;;
  esac
done