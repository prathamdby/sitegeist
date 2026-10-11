# Proxy Architecture

## Overview

Sitegeist implements CORS proxy selection locally in `src/pi/stream.ts`, document extraction in `src/tools/extract-document.ts`, key validation in `src/components/ProviderKeyInput.ts`, and the Proxy settings UI in `src/dialogs/SettingsDialog.ts`. There is no external transport or proxy utility module in this contract.

The proxy is optional and is used for two separate cases:

1. Selected provider requests whose browser API calls need a proxy.
2. Document downloads that fail with a detected CORS/fetch error and have a proxy URL configured.

## Settings and URL Format

`ProxyTab` stores `proxy.enabled` (boolean) and `proxy.url` (string) through the local settings store. When values are missing, the tab displays disabled and `http://localhost:3001`. The sidepanel currently writes `proxy.enabled = false` at startup; enabling the toggle in Settings is needed for provider proxying during that run. Sitegeist does not prescribe a hosted proxy as a default.

The configured service must accept requests in the form `<proxy-url>/?url=<encoded-target-url>`. The provider stream encodes the model base URL in the `url` query parameter. For document downloads, `sidepanel.ts` passes the prefix `<proxy-url>/?url=` to `extract_document`, which appends the encoded document URL.

## Provider API Requests

`createStreamFn(getProxyUrl)` in `src/pi/stream.ts` wraps the local provider stream with Pi's `lazyStream`. It reads the proxy URL for a request and rewrites `model.baseUrl` only when the proxy is enabled and the model has a base URL. The current selector is:

- `zai` models use the proxy.
- `openai-codex` models use the proxy.
- `anthropic` uses the proxy for OAuth-style credentials whose key starts with `sk-ant-oat` or `{`.
- Other provider IDs are sent directly by this selector.

`src/components/ProviderKeyInput.ts` applies the same provider/key cases when validating a pasted API key. OAuth credentials themselves are not accepted by that API-key validation path.

## Document Extraction

`extract_document` first calls `fetch(documentUrl)`. It retries through its configured `corsProxyUrl` only when the direct fetch fails with an error matching `cors` or `failed to fetch`; aborts and other errors are not retried. If no proxy URL is configured, the tool reports the CORS failure and suggests proxy configuration or manual download. If the proxied request also fails, it reports both attempts. A non-OK HTTP response is reported as a download failure rather than retried through the proxy.

`sidepanel.ts` supplies `corsProxyUrl` when it creates the tool and both `proxy.enabled` and `proxy.url` are present. The tool then enforces its document-size limit and parses supported PDF, DOCX, XLSX/XLS, and PPTX data through the local attachment processing module.

## Privacy and Failure Handling

A proxy service receives the target URL and relays the request; depending on the provider protocol, request headers or payloads may include authentication data. The storage setting only controls whether Sitegeist uses the configured URL; it does not establish the proxy operator's retention, logging, or privacy policy. Use a proxy you trust, and avoid entering sensitive credentials when its handling is unknown.

The proxy does not make every provider or document request succeed. Provider request failures still surface through the Pi stream; extraction retries only its recognized direct-fetch CORS failures. Users can disable the setting or enter a different compatible proxy URL.

## Related Files

- [Provider stream proxy selection](../src/pi/stream.ts)
- [API key validation](../src/components/ProviderKeyInput.ts)
- [Document extraction fallback](../src/tools/extract-document.ts)
- [Proxy settings UI](../src/dialogs/SettingsDialog.ts)
- [Agent and tool configuration](../src/sidepanel.ts)
- [Settings storage contract](./settings.md)
