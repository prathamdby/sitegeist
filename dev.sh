#!/bin/bash
set -euo pipefail

if [ ! -d "../pi-mono/packages/web-ui/dist" ]; then
    echo "Error: pinned legacy pi-web-ui is not built; run the project Setup first."
    exit 1
fi

exec npm run dev
