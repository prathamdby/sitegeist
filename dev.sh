#!/bin/bash
set -euo pipefail

if [ ! -x "node_modules/.bin/esbuild" ] || [ ! -x "node_modules/.bin/tailwindcss" ]; then
    echo "Error: extension dependencies are missing; run npm ci first."
    exit 1
fi

exec npm run dev
