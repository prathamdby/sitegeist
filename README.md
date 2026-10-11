<p align="center">
  <img src="media/hero.png" alt="Sitegeist" width="400">
</p>

An AI assistant that lives in your browser sidebar. Built for collaboration, not autonomy theater. You guide, it executes.

Sitegeist can automate repetitive web tasks, extract data from any website, navigate across pages, fill out forms, compare products, compile research, and transform what it finds into documents, spreadsheets, or whatever you need. It works on any website through a Chrome/Edge side panel, using the AI provider of your choice.

Bring your own API key or log in with an existing subscription (Anthropic Claude, OpenAI/ChatGPT, or GitHub Copilot). Google Gemini is available with an API key. Your data stays on your machine. Nothing is collected or tracked.

## Download & Install

Download packaged releases from [GitHub Releases](https://github.com/badlogic/sitegeist/releases). To install a release, unzip it, open `chrome://extensions/` or `edge://extensions/`, enable Developer mode, and load the extracted folder.

Requires Chrome 141+ or Edge equivalent.

## Development

Install the locked dependencies from the repository root:

```bash
npm ci
```

The lockfile pins `@mariozechner/mini-lit` to `0.2.1`; no sibling repository checkout is required. `npm ci` also runs the repository's package setup hooks.

Start the extension build, CSS, and development-server watchers:

```bash
./dev.sh
```

`./dev.sh` runs the root project's watchers against the installed, lockfile-pinned npm dependencies.

### Loading the extension

1. Open `chrome://extensions/` or `edge://extensions/`
2. Enable Developer mode
3. Click Load unpacked
4. Select `sitegeist/dist-chrome/`
5. Click "Details" on the Sitegeist extension and enable:
   - **Allow user scripts**
   - **Allow access to file URLs**

The extension hot-reloads when the dev watcher rebuilds.

### First run

On first launch, Sitegeist prompts you to connect at least one AI provider. You can log in with a subscription or enter an API key.

Some provider requests (including Anthropic OAuth, OpenAI Codex, and Z-AI) may require a CORS proxy, configurable in **Settings → Proxy**. Proxying is disabled at startup; enable it and enter a proxy URL you trust when needed.

## Checks

```bash
./check.sh
```

Runs formatting, linting, and type checking for the extension.

The Husky pre-commit hook runs the same checks before each commit.

## Building

```bash
npm run build
```

The unpacked extension is written to `dist-chrome/`.

## Releasing

```bash
./release.sh patch   # 1.0.0 -> 1.0.1
./release.sh minor   # 1.0.0 -> 1.1.0
./release.sh major   # 1.0.0 -> 2.0.0
```

Bumps the version in `static/manifest.chrome.json`, commits, tags, and pushes. GitHub Actions builds the extension and creates a release at [github.com/badlogic/sitegeist/releases](https://github.com/badlogic/sitegeist/releases).

## License

AGPL-3.0. See [LICENSE](LICENSE).
