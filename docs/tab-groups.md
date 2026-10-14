# Background Tab Groups

Opt-in behavior behind the Tabs settings toggle (off by default).

## Model

- One session owns one tab group plus one pinned panel tab (D1). The panel
  stays on the tab it was opened on; the agent's acting tab moves inside the
  group as it works.
- A new session spawns its own inactive worker tab in a fresh "Sitegeist"
  group. The user's tab is never grouped and never acted on: plain
  navigation goes to the acting worker tab, and new tabs open inactive
  inside the group.
- Every tab-touching call resolves through `src/browser/session-tabs.ts`.
  Flag off, or no scope: the legacy active tab in the current window. Flag
  on with a scope: `chooseActingTabId(scope, liveGroupTabIds)` picks an id
  inside the live group (recorded acting tab, else another group member,
  else the bound panel tab only when that tab is itself in the group). A
  foreign id is never returned. No `groupId` uses the recorded tab ids.
  An empty or failed group query does not. An empty candidate list returns
  undefined, and `resolveActingTab` throws instead of querying the window's
  active tab.
  Adopting a sibling records that id and the live group ids on the scope.

## Enable

Settings → Tabs → Background tabs. Takes effect for new sessions; existing
sessions adopt a group when reopened. Stored as `tabScope.enabled` in both
the settings record and `chrome.storage.local` (the channel the background
worker can read). The sidepanel sync mirror is primed from that key and
updated by `chrome.storage.onChanged`, so a click after the toggle does not
keep seeing the default false.

## Parallel sessions

- One panel runs one session. Pressing + in the same panel aborts the
  running agent and starts over there.
- For two independent sessions: the header's pop-out button (or the
  extension icon on another tab) opens a fresh panel on a new tab. Each
  panel binds to its own tab, owns its own worker group, and keeps
  streaming while you look at the other tab. Put the two tabs in two
  windows to watch both side by side.
- A session bound to one tab cannot be opened by another tab's panel: the
  background denies the lock while the owner tab is alive, and the session
  list shows it as locked. Switching sessions releases the scope from the
  owning tab, so the old session is immediately adoptable elsewhere. A
  different tab cannot release a live owner.

## Tool behavior when on

- `navigate`: new tabs open inactive (`active:false`) and are grouped;
  `listTabs` reports only group tabs; `switchToTab` rejects foreign ids
  before any focus change.
- `browserjs()`, overlay, debugger, element picker, skill URL, native input:
  act on the session's acting tab, never the global active tab.
- Screenshots: the visible-tab fast path runs only when the acting tab is
  the visible tab of its window; otherwise capture goes through the
  debugger protocol, so the agent never receives a foreign tab's pixels.
- Rendered tab pills and navigation messages open tabs inactive in-group.
  User clicks are explicit gestures and may still focus tabs.

## Lifecycle

- The background (`src/background.ts`) owns `sessionId -> {groupId,
  boundTabId, actingTabId, windowId}` in `chrome.storage.session`, so state
  survives service worker sleep. There is one store. The caller is the
  port name: `sidepanel:tab:<tabId>:<sessionId>` or legacy
  `sidepanel:<windowId>`.
- `acquireTabScope`: a tab-bound port may bind only its own tab (the port
  tab id must equal `msg.tabId`). If a record exists and that bound tab is
  still alive, a different requester is rejected (`success: false`,
  `tabIds: []`). A dead bound tab may be overwritten. A legacy window port
  cannot take a live tab-bound owner, even if the message claims that
  owner's tab id.
- `releaseTabScope`: deletes only when the port's tab id is the record's
  `boundTabId`, or the caller is a legacy window port and the bound tab is
  already gone. A different tab cannot delete a live or dead owner.
  Dead-owner reclaim goes through acquire, not a cross-tab delete. The
  reply is still sent so the port client does not time out; a refusal
  leaves the record in place.
- `updateActingTab`: the tab must exist. When the record has a `groupId`,
  the tab's `groupId` must match or the update is rejected. When it does
  not, only the existing acting tab id is accepted.
- One tab group per session: the assignment `sessionId -> groupId`
  (`tab_groups` in `chrome.storage.session`) persists across session
  switches. Switching releases only the panel binding, never the
  assignment. A new group is created only when the recorded group is gone
  (deleted, empty, or unverifiable). Group deletion clears the assignment
  via `tabGroups.onRemoved`.
- Bound tab closed → scope released. Acting tab closed → the record falls
  back to the bound tab, but resolution will not act on that tab unless it
  is in the live group; it adopts a surviving group member instead. Group
  deleted by the user → binding kept, group id cleared so the next run
  recreates it. Tab replaced (crash restore) → ids remapped. Window closed
  → scopes for that window released.
- A legacy window-port disconnect releases that window's session locks. A
  tab-bound port disconnect (reload, panel close) keeps the scope record
  so the same tab re-adopts its group. Session switch releases through
  `releaseTabScope` from the owning tab.

## Edge cases

- Restricted URLs (`chrome://`, `chrome-extension://`, `about:`) cannot run
  scripts; tools report errors instead.
- OAuth tabs open outside the group and may take focus; they are user-driven.
- Moving the bound tab out of its group keeps the recorded scope rather
  than adopting foreign tabs.
- `chrome.tabs.captureVisibleTab` can only see the visible tab, hence the
  debugger path for background tabs.
- Parallel sessions in two windows each stream against their own group;
  navigation events from foreign tabs never steer another session's agent.

## Kill switch

Turn the toggle off: all callers fall back to window-scoped behavior. No
schema migration is involved (groups are runtime Chrome state; session
records are unchanged), so nothing needs backfilling on rollback.

## Group click opens session

Clicking a tab that belongs to another session's group opens that session
in the clicked tab's panel:

- Same-session clicks are ignored here; the existing in-group steer logic
  owns them.
- When the owning panel tab is still alive, the click reveals it
  (`sidePanel.open` on the bound tab) instead of moving the session.
- When no live owner exists, the click adopts the session in place: the
  session id is stashed under `tabGroup.pendingSession` in
  `chrome.storage.session`, the panel is rebound with
  `sidePanel.setOptions` to `sidepanel.html?session=...&tabId=...`, and the
  panel is opened on the clicked tab. On load, `initApp` consumes the
  stashed id only when the URL carries no session of its own.
- Idle-only rule: adoption happens only when this panel is not streaming.
  While this panel streams, the click is silently ignored and the other
  session keeps running.
- Agent-driven activations (`switchToTab` navigating) never trigger a
  switch; the handler returns early while a tool navigation is in flight.
- The pure decision matrix lives in `src/browser/group-open.ts`
  (`resolveGroupClick`) and is covered by
  `tests/tab-group-open-contract.test.mjs`.
