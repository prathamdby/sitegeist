#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

install_dependency() {
    local directory="$1" revision="$2"
    if [ ! -d "../$directory" ]; then
        git clone --no-checkout --depth 1 "https://github.com/badlogic/$directory.git" "../$directory"
        git -C "../$directory" fetch --depth 1 origin "$revision"
        git -C "../$directory" switch --detach "$revision"
    fi
    if [ "$(git -C "../$directory" rev-parse HEAD)" != "$revision" ]; then
        printf 'Unexpected %s revision; preserve local work and resolve before retrying.\n' "$directory" >&2
        return 1
    fi
    npm install --no-save --no-audit --no-fund --prefix "../$directory"
}

install_dependency mini-lit dee21bf1175de0cb16a946ba8fb62c1e590fbd3c
install_dependency pi-mono 83378aad7e74a0e2bb8f37c007a9685fb4609d8a
(cd ../mini-lit && ./node_modules/.bin/tsc)
(
    cd ../pi-mono
    ./node_modules/.bin/tsgo -p packages/tui/tsconfig.build.json
    ./node_modules/.bin/tsgo -p packages/ai/tsconfig.build.json
    ./node_modules/.bin/tsgo -p packages/agent/tsconfig.build.json
    cd packages/web-ui
    ../../node_modules/.bin/tsc -p tsconfig.build.json
    ../../node_modules/.bin/tailwindcss -i ./src/app.css -o ./dist/app.css --minify
)
