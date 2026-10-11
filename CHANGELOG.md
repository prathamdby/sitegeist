# Changelog

## [Unreleased]

### Changed

- Migrated the agent runtime and model/auth registry to `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` 1.1.0, retaining the existing UI and stored data formats.
- Replaced the web-ui storage implementation with application-owned persistence while retaining the version-3 database and rollback-compatible records.
- Replaced the model selector and settings shell with local components, retaining provider filtering, browser OAuth and custom model discovery; exposed OpenCode API key entry.
- Replaced the chat shell, composer and message/tool rendering with local components driven by Pi 1.1.0, retaining attachment and artifact services and sequential navigation steering behavior.
- Replaced attachment processing, previews, REPL file access and document extraction with local implementations, preserving upload flows, parser formats and saved attachment bytes.
- Replaced production REPL and skill sandbox execution with a local runtime bridge, preserving browser helpers, attachment reads, cancellation and extension CSP.
- Replaced artifact storage, previews, downloads and the debug JavaScript REPL with local implementations, retaining the existing controls and stored artifact messages.

### Fixed

- Bound REPL Stop messages and overlay cleanup to their originating tab and execution, rejecting stale or forged requests.
- Quoted native-input selectors in debugger error expressions and reported missing browser-script results as execution failures.
- Enforced read-only artifact access from isolated HTML previews and excluded failed artifact operations from session restoration.

### Removed

- Removed the marketing site, site-specific development and deployment tooling, and website-backed extension update links.
- Removed Gemini CLI subscription login and the Gemini CLI/Antigravity provider routes. Existing stored credentials are preserved; users with a saved model from a removed provider must select another model.

## [1.0.0] - 2026-03-15

### Added

- Browser-based OAuth login for Anthropic (Claude Pro/Max), OpenAI Codex (ChatGPT Plus/Pro), GitHub Copilot, and Google Gemini CLI
- Combined "API Keys & OAuth" settings tab with subscription login and API key entry
- Welcome setup dialog on first launch when no providers are configured
- Auto-select default model for the first provider with a key
- Provider and auth type indicator in the header bar
- Image extraction tool (`extract_image`) with selector and screenshot modes
- Subsequence-based fuzzy search in the model selector
- CORS proxy warning in OAuth sections (orange when enabled, red when disabled)
- GitHub Actions workflow for tagged releases
- `release.sh` script for version bumping and tagged releases

### Changed

- Default model changed to `claude-sonnet-4-6` with `medium` thinking level
- CORS proxy enabled by default
- Model selector only shows models from providers with configured keys
- API key prompt dialog now shows both OAuth login and API key entry for supported providers
- Tool execution set to sequential mode (parallel caused rendering issues in sidebar)
- Site converted to static (removed backend, admin, waitlist signups)
- Download links point to GitHub Releases
- License changed from MIT to AGPL-3.0

### Fixed

- Settings dialog tabs not responding to clicks (upstream `pi-web-ui` built with `tsgo` broke Lit decorator reactivity)
- CORS proxy toggle not updating (same root cause)
- Proxy not applied to API requests (esbuild bundled duplicate `streamSimple` references, breaking identity check)
- Model selector button not updating after picking a model (added `state_change` event to Agent)
- Duplicate tool component rendering during streaming (cleared streaming container on `message_end`)
- Screenshot tool capturing sidepanel instead of the webpage
