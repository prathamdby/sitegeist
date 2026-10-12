# Changelog

## [Unreleased]

### Added

- Each chat opens its own background tab group. The agent navigates and reads only those tabs, and screenshots come from the task tab rather than the visible window.
- Bound each task to the tab it was opened on. The side panel is enabled only for that tab, and a tab with no task does not show it.

### Changed

- Session locks now belong to the owning tab instead of the window, so two windows can show two tasks at the same time. A newly opened tab starts a new task instead of taking the latest chat. The side-panel shortcut opens the task for the active tab.
- Migrated the agent runtime and model/auth registry to `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` 1.1.0, retaining the existing UI and stored data formats.
- Replaced the web-ui storage implementation with application-owned persistence while retaining the version-3 database and rollback-compatible records.
- Replaced the model selector and settings shell with local components, retaining provider filtering, browser OAuth and custom model discovery; exposed OpenCode API key entry.
- Replaced the chat shell, composer and message/tool rendering with local components driven by Pi 1.1.0, retaining attachment and artifact services and sequential navigation steering behavior.
- Replaced attachment processing, previews, REPL file access and document extraction with local implementations, preserving upload flows, parser formats and saved attachment bytes.
- Replaced production REPL and skill sandbox execution with a local runtime bridge, preserving browser helpers, attachment reads, cancellation and extension CSP.
- Replaced artifact storage, previews, downloads and the debug JavaScript REPL with local implementations, retaining the existing controls and stored artifact messages.
- Retired the legacy Pi UI package and temporary bridges. Locked npm dependencies now support installation, development watchers, checks and releases without sibling repositories.

### Fixed

- A tab that is refused a session locked by another tab drops that session from its panel URL, and a mismatched lock request reports the recorded owner.
- Kept a session lock when the side-panel port times out, and ignored panel messages that name a different tab than the connection.
- Bound REPL Stop messages and overlay cleanup to their originating tab and execution, rejecting stale or forged requests.
- Quoted native-input selectors in debugger error expressions and reported missing browser-script results as execution failures.
- Enforced read-only artifact access from isolated HTML previews and excluded failed artifact operations from session restoration.
- Escaped sandbox identifiers in runtime scripts so script-data markers in filenames cannot swallow downloaded HTML documents.
- Fixed sidepanel startup hanging on Loading while restoring artifacts before the panel is attached.
- Restored full-size artifact-panel host layout when switching between split and narrow overlay modes.
- Forwarded the chat session id to the Pi agent so OpenCode Go requests carry the required per-conversation routing header from the first turn.
- Listed OpenCode Go in the settings API-key section so its key can be entered before model selection.

### Removed

- Removed the marketing site, site-specific development and deployment tooling, and website-backed extension update links.
- Removed Gemini CLI subscription login and the Gemini CLI/Antigravity provider routes. Existing stored credentials are preserved; users with a saved model from a removed provider must select another model.
- Removed the Capy agent setup manifest and the `~/.capy/work` scratch paths used by browser tests.

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
