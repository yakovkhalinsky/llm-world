#!/usr/bin/env bash
# grove — thin wrapper: grove.sh run, grove.sh step 100 …
cd "$(dirname "$0")"
exec python3 -m grove "$@"