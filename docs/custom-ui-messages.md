# Custom UI Messages

## Overview

Sitegeist extends Pi agent messages with application-owned roles, renders them through its local Lit renderer registry, and explicitly decides what reaches the model in `browserMessageTransformer`. Message typing, UI rendering, and model conversion are separate contracts.

## Core Concepts

### Message Types

`AgentMessage` is the Pi agent-core message union extended by declaration merging through `CustomAgentMessages`. Sitegeist declares its roles beside their implementation.

**Extending**: Add custom types via declaration merging
```typescript
declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    welcome: WelcomeMessage;
    navigation: NavigationMessage;
  }
}
```

### Message Lifecycle

```
User Action
    ↓
Create AgentMessage
    ↓
agent.appendMessage()
    ↓
    ├─→ UI: renderMessage() → Custom Renderer → Display
    └─→ LLM: messageTransformer() → Transform/Filter → LLM
```

## Implementation

### 1. Define Message Type

```typescript
export interface NavigationMessage {
  role: "navigation";
  url: string;
  title: string;
  favicon?: string;
  tabId?: number;
  skillsOutput: string;
}

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    navigation: NavigationMessage;
  }
}
```

### 2. Create Custom Element

```typescript
@customElement("navigation-message")
class NavigationMessageElement extends LitElement {
  @property() url!: string;
  @property() title!: string;
  @property() favicon?: string;

  protected createRenderRoot() {
    return this; // Light DOM for shared styles
  }

  override render() {
    return html`
      <div class="my-2">
        <button
          class="inline-flex items-center gap-2 px-3 py-2 bg-card border rounded-lg"
          @click=${() => chrome.tabs.create({ url: this.url })}
        >
          <img src="${this.favicon}" class="w-4 h-4" />
          <span>${this.title}</span>
        </button>
      </div>
    `;
  }
}
```

### 3. Create Renderer

**Simple (no agent access)**:
```typescript
import type { MessageRenderer } from "../chat/renderers/index.js";

const navigationRenderer: MessageRenderer<NavigationMessage> = {
  render: (msg) => html`<navigation-message
    .url=${msg.url}
    .title=${msg.title}
    .favicon=${msg.favicon}>
  </navigation-message>`,
};
```

**With app access (the welcome-message pattern)**:
```typescript
function createWelcomeRenderer(agent: Agent, agentInterface: AgentInterface): MessageRenderer<WelcomeMessage> {
  return {
    render: (message) => html`<welcome-message
      .tutorials=${message.tutorials}
      .agent=${agent}
      .agentInterface=${agentInterface}
      .message=${message}>
    </welcome-message>`,
  };
}
```

### 4. Register Renderer

```typescript
import { registerMessageRenderer } from "../chat/renderers/index.js";

registerMessageRenderer("navigation", navigationRenderer);
```

### 5. Transform for the Model

`src/messages/message-transformer.ts` owns the current conversion contract. It filters `artifact` and `welcome`, converts `navigation` to browser-context user text using the message's frozen skills snapshot, and converts `user-with-attachments` to user text/image content. System, user, assistant, and tool-result messages pass through; other custom roles are skipped unless the transformer explicitly handles them. Tool-call results are reordered next to their matching assistant call.

When adding a custom role, update this transformer separately from the UI renderer. Choose whether it is UI-only, converted to a model-supported message, or passed through as a valid Pi message. Never forward an application-only role unchanged or cast it to the model message type.

## Patterns

### UI-Only Message (Welcome Screen)

Never sent to LLM:

```typescript
export interface WelcomeMessage {
  role: "welcome";
  tutorials: Array<{ label: string; prompt: string }>;
}

// Renderer with conditional display
function createWelcomeRenderer(agent: Agent): MessageRenderer<WelcomeMessage> {
  return {
    render: (message) => {
      // Hide if conversation started
      const hasConversation = agent.state.messages.some(
        m => (m.role === "user" || m.role === "assistant") && m !== message
      );

      if (hasConversation) return html``;

      return html`<welcome-message .tutorials=${message.tutorials}></welcome-message>`;
    },
  };
}

// Transformer filters it out
if (m.role === "welcome") continue;
```

### Transformed Message (Navigation)

UI shows clickable pill, LLM receives context:

```typescript
// UI renderer
const renderer = {
  render: (msg) => html`<navigation-message .url=${msg.url} .title=${msg.title} />`,
};

// The message stores the formatted skill snapshot from navigation time.
if (m.role === "navigation") {
  const tabInfo = m.tabId !== undefined ? ` (tab id: ${m.tabId})` : "";
  transformed.push({
    role: "user",
    content: `<browser-context>Navigation succeeded: ${m.title}${tabInfo}\nURL: ${m.url}\n${m.skillsOutput}</browser-context>`,
    timestamp: Date.now(),
  });
}
```

`createNavigationMessage()` captures matching skills when the navigation message is created; the transformer does not re-query the skills store.

## Event-Based Actions

Custom elements dispatch DOM events for actions:

```typescript
// In custom element
private selectTutorial(prompt: string) {
  this.dispatchEvent(
    new CustomEvent("tutorial-selected", {
      detail: { prompt },
      bubbles: true,
      composed: true,
    })
  );
}

// In app initialization
document.addEventListener("tutorial-selected", (e: CustomEvent) => {
  // Remove welcome message
  agent.replaceMessages(agent.state.messages.filter(m => m.role !== "welcome"));

  // Send tutorial prompt
  agentInterface.sendMessage(e.detail.prompt);
});
```

## Best Practices

### ✅ DO
- Store minimal data in messages (they persist in session storage)
- Use factory pattern for renderers needing agent state
- Use DOM events for actions requiring `agentInterface`
- Filter UI-only messages in `browserMessageTransformer`
- Load async data in `connectedCallback()`
- Make transformer async if needed

### ❌ DON'T
- Store callbacks in messages (won't persist)
- Send custom roles directly to the model unless the transformer converts them
- Store DOM objects in persisted messages; pass controllers through a renderer factory or use bubbling DOM events
- Assume custom elements cannot receive app references: `WelcomeMessage` supplies its agent and interface through renderer-created properties
- Forget to register renderers before messages appear

## Files

**Core:**
- `src/chat/renderers/Messages.ts` and `src/chat/renderers/MessageList.ts` - Message rendering
- `src/chat/renderers/message-registry.ts` - Local renderer registration
- `src/messages/message-transformer.ts` - Model conversion

**Examples:**
- `src/messages/NavigationMessage.ts` - Navigation message
- `src/messages/WelcomeMessage.ts` - UI-only message
- `src/messages/message-transformer.ts` - Message transformation
- `src/sidepanel.ts` - Agent setup and event handling
