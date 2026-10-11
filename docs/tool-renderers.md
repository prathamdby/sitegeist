# Tool Renderers

## Overview

Tool renderers customize how tool invocations and their results appear in the chat interface. Each tool can provide a renderer that controls both the visual presentation and layout structure.

## Architecture

### ToolRenderResult Interface

```typescript
interface ToolRenderResult {
  content: TemplateResult;
  isCustom: boolean;
}
```

- **`content`**: Lit template to render
- **`isCustom`**: Result metadata returned by the renderer. The current `sitegeist-tool-message` wraps `content` in its chat card either way, so do not rely on this flag to suppress the outer wrapper.

### ToolRenderer Interface

The local registry imports `JsonObject`, `JsonValue`, and `ToolResultMessage` from Pi AI; renderer registration, lookup, and formatting helpers are owned by Sitegeist.

```typescript
interface ToolRenderer<TParams = JsonObject, TDetails = JsonValue> {
  render(
    params: TParams | undefined,
    result: ToolResultMessage<TDetails> | undefined,
    isStreaming?: boolean
  ): ToolRenderResult;
}
```

Receives:
- **`params`**: Tool input parameters (may be partial during streaming)
- **`result`**: Tool execution result (undefined until complete)
- **`isStreaming`**: Whether tool is currently executing

## Rendering States

Renderers should handle all execution states:

1. **Arguments unavailable**: The renderer accepts `params` as `undefined` while tool input is unavailable.
2. **Executing**: Arguments are available, but the tool result is not.
3. **Complete**: Execution finished with a result.
4. **Error**: Execution failed with an error result.

## Implementation

### Registration

```typescript
import { registerToolRenderer } from "../chat/renderers/index.js";

registerToolRenderer("tool_name", toolRenderer);
```

### Example: Renderer Result

```typescript
const myRenderer: ToolRenderer<MyParams, MyResult> = {
  render(params, result, isStreaming) {
    if (result) {
      return {
        content: html`<div class="result">${toolResultText(result)}</div>`,
        isCustom: false,
      };
    }

    return {
      content: html`<div class="loading">Executing...</div>`,
      isCustom: false,
    };
  }
};
```

### Example: Custom Template Content

```typescript
const navigateRenderer: ToolRenderer<NavigateParams, NavigateResult> = {
  render(params, result) {
    if (result && !result.isError && result.details) {
      return {
        content: html`
          <div class="my-2">
            <button class="inline-flex items-center gap-2 px-3 py-2 text-sm bg-card border rounded-lg">
              <img src="${result.details.favicon}" class="w-4 h-4" />
              <span>${result.details.title}</span>
            </button>
          </div>
        `,
        isCustom: true,
      };
    }

    return {
      content: html`<div class="my-2">Navigating...</div>`,
      isCustom: true,
    };
  }
};
```

## Built-in Renderers

**Sitegeist built-in renderers** (`src/tools/index.ts`):
- `bash` - Command output via `BashRenderer`
- `calculate` - Expression status via `CalculateRenderer`
- `get_current_time` - Time lookup via `GetCurrentTimeRenderer`

**Tool-specific renderers**:
- `repl` - Page JavaScript execution with collapsible code
- `javascript_repl` - Debug REPL rendering
- `skill` - Skill management operations
- `navigate` - Page navigation
- `ask_user_which_element` - Element picker
- `extract_document` and `extract_image` - Document and image extraction
- `debugger` - Browser debugger tool
- `artifacts` - Registered by `ChatPanel` when initialized

## Best Practices

### Visual Consistency
- Use Tailwind utility classes from theme
- Follow spacing patterns: `my-2` for vertical, `gap-2` for flex
- Use semantic colors: `text-card-foreground`, `bg-card`, `border-border`

### State Handling
```typescript
render(params, result, isStreaming) {
  // Loading state
  if (!result && params) {
    return { content: html`<div>Loading...</div>`, isCustom: false };
  }

  // Error state
  if (result?.isError) {
    return { content: html`<div class="text-destructive">${toolResultText(result)}</div>`, isCustom: false };
  }

  // Success state
  if (result) {
    return { content: html`<div>${toolResultText(result)}</div>`, isCustom: false };
  }

  // Waiting state
  return { content: html`<div>Waiting...</div>`, isCustom: false };
}
```

### `isCustom` Result Flag

Set `isCustom` to the value appropriate for the renderer's result contract, but note that `sitegeist-tool-message` currently wraps returned content in its card regardless of the flag. Custom renderers control the template content; they do not remove that outer wrapper.

## Files

**Core:**
- `src/chat/renderers/tool-registry.ts` - Renderer and result contracts, registry, default renderer
- `src/chat/renderers/Messages.ts` - Tool-call rendering
- `src/chat/renderers/MessageList.ts` - Message and result matching
- `src/tools/` - Tool-specific renderer registrations
- `src/artifacts/ArtifactsToolRenderer.ts` - Artifact renderer
