# Per-tab tasks

## Overview

Each task belongs to the tab it was opened on. The side panel is enabled for that tab, and for tabs the task later owns, and nowhere else. Two tabs can hold two tasks, including tabs in two windows. A session still has a single owner, so the same chat cannot be open on two tabs at once.

## Behavior

**Toolbar icon or Ctrl/Cmd+Shift+S** on a tab with no task opens a new task on that tab. The same control on a tab that already has a task reopens it. The shortcut does not close the panel.

**Another tab** in the same window, or a tab in a second window, gets its own task. It does not take the latest saved chat. In the session list, the chat open on this tab is Current. A chat open on another tab is Locked, dimmed, and not selectable.

**New chat** stays on the same tab. The previous chat remains locked to any work tabs that still belong to it.

Locks stay with the owner tab while that tab exists. An idle port disconnect does not release them. They drop when the owner tab closes, the window goes away, or startup finds the tab already gone.

## Architecture

The service worker (`src/background.ts`) stores three maps in `chrome.storage.session`:

- `panel_bindings`: tab id to `{ ownerTabId, sessionId, role }`
- `session_locks`: session id to owner tab id
- `open_panel_tabs`: owner tab ids with a connected panel

An in-memory copy of the bindings lets the toolbar click call `chrome.sidePanel.setOptions` and `chrome.sidePanel.open({ tabId })` in the same turn. The manifest has no default side panel path. Default panel options stay disabled, and owned tabs opt in with `sidepanel.html?hostTab=<id>`.

The panel connects with `chrome.runtime.connect({ name: "sidepanel:<ownerTabId>" })`. `src/utils/port.ts` sends `acquireLock`, `getLockedSessions`, `getBinding`, and `clearHostBinding`. The service worker uses the port name as the owner tab and ignores a different tab id in the message. Disconnect drops that connection's refcount and leaves the lock in place.

On the first wake after the window-scoped design, `panel_model` is set to `tab` and the old lock map is cleared so a window id is not treated as a tab id.

`src/dialogs/SessionListDialog.ts` compares each lock to the panel's owner tab id.

## Edge cases

- **Service worker sleep.** The port keeps the worker awake. Records live in `chrome.storage.session`, which also survives an extension reload and is cleared when the browser process ends.
- **Tab replaced.** `chrome.tabs.onReplaced` moves the binding, the lock, and the panel options to the new tab id.
- **Owner tab or window closed.** Locks and bindings for tabs that no longer exist are dropped.
- **Direct URL.** `?session=` still tries to acquire the lock and shows a new task when another tab holds it. `?hostTab=` is the normal path. A page opened without it, including the debug page, uses the active tab.
