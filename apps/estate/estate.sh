#!/usr/bin/env bash
# estate — thin wrapper: estate.sh step 30, estate.sh map …
cd "$(dirname "$0")"
exec python3 -m estate "$@"
