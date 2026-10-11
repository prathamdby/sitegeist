# Development Rules

## First Message
If the user did not give you a concrete task, read README.md first.

## Commands
- After code changes: run `./check.sh`. Fix all errors and warnings before committing.
- The user runs `./dev.sh` in a separate tmux session. Do not run `npm run dev` or `npm run build`.
- NEVER commit unless the user asks.

## Code Quality
- No `any` types unless absolutely necessary
- Check node_modules for external API type definitions instead of guessing
- NEVER use inline imports (no `await import(...)`, no `import("pkg").Type`)
- Always ask before removing functionality or code that appears intentional

## Dependencies
- Dependencies install from the root lockfile with `npm ci`; no sibling repositories are required.
- Pi SDK packages are pinned to `@earendil-works/pi-ai@1.1.0` and `@earendil-works/pi-agent-core@1.1.0`.
- UI primitives stay on `@mariozechner/mini-lit@0.2.1`; Sitegeist owns its chat, settings, storage and sandbox implementations.

## Changelog
Location: `CHANGELOG.md`

### Format
Use these sections under `## [Unreleased]`:
- `### Breaking Changes`
- `### Added`
- `### Changed`
- `### Fixed`
- `### Removed`

### Rules
- New entries ALWAYS go under `## [Unreleased]`
- Append to existing subsections, do not create duplicates
- NEVER modify already-released version sections

## Releasing
When the user asks to do a release:
1. Ask: major, minor, or patch?
2. Ensure `CHANGELOG.md` has entries under `## [Unreleased]`
3. Run `./release.sh <major|minor|patch>`

The script bumps the version in `static/manifest.chrome.json`, finalizes the changelog, commits, tags, and pushes. GitHub Actions builds and publishes the release.

## Style
- No emojis in commits, code, or comments
- No fluff or cheerful filler text
- Technical prose only, direct and concise

## Git Rules
- NEVER use `git add -A` or `git add .`
- ALWAYS use `git add <specific-file-paths>`
- NEVER use `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`
- NEVER use `git commit --no-verify`
- Include `fixes #<number>` or `closes #<number>` in commit messages when applicable

## Project Structure
```
src/
  sidepanel.ts          # Main entry point, agent setup, settings, rendering
  background.ts         # Service worker (sidepanel toggle, session locks)
  oauth/                # Browser OAuth flows (Anthropic, OpenAI, GitHub, Gemini)
  dialogs/              # Settings tabs, API key dialogs, welcome setup
  tools/                # Agent tools (navigate, REPL, extract-image, skills, debugger)
  messages/             # Custom message types (navigation, welcome)
  storage/              # IndexedDB storage (sessions, skills, costs)
  prompts/              # System prompt and token counting
  components/           # UI components (Toast, TabPill, OrbAnimation)
static/
  manifest.chrome.json  # Extension manifest (version lives here)
```

## Cursor Cloud specific instructions

- `install` places Node 22.23.3 (the version in `.github/workflows/check.yml`) on `~/.local/bin` and `/usr/local/bin`. Login shells resolve `node` from `~/.local/bin`. `/exec-daemon/node` is an older Node 22; do not use it for `npm ci`, `./check.sh`, or tests.
- `start` runs `./dev.sh`, which watches the extension and serves the reload socket on port 8765. If that port is open, leave the watcher running.
- Load `dist-chrome/` as an unpacked extension. On the extension Details page, enable Allow user scripts. Until that toggle is on, the side panel can remain on "Loading...". With it on, first launch shows "Welcome to Sitegeist" and the API Keys & OAuth settings.
