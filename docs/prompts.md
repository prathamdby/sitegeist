# Prompts Architecture

## Overview

This document describes the current architecture of prompts, tool descriptions, and runtime provider descriptions. Use this as a reference for understanding how prompts work and as a guide for adding new tools or modifying existing ones.

**Current implementation**: Tool prompts and provider descriptions live in `src/prompts/`; the sandbox-provider interface and execution machinery are local under `src/sandbox/`. No prompt or runtime-provider implementation is supplied by an external UI package.

## Core Concepts

### 1. Tools
Tools are capabilities that the LLM can invoke. Each tool has:
- **Name**: Identifier (e.g., `browser_repl`, `artifacts`)
- **Label**: Human-readable name
- **Parameters**: JSON schema defining inputs
- **Description**: Instructions for the LLM on when and how to use the tool
- **Execute**: Function that runs when the tool is called

### 2. Runtime Providers
Runtime providers inject special functions into sandboxed execution environments. Each provider implements the local `SandboxRuntimeProvider` interface in `src/sandbox/types.ts`:
- **getData()**: Returns a `Record<string, unknown>` injected into the sandbox window.
- **getRuntime()**: Returns a function that is serialized into the sandbox to define helper functions.
- **getDescription()**: Returns model-facing documentation for those functions.
- **handleMessage()**: Optional asynchronous handler for runtime requests.
- **onExecutionStart() / onExecutionEnd()**: Optional lifecycle hooks; `onExecutionStart()` can receive an abort signal.

### 3. Tool Descriptions with Provider Injection
Tool descriptions are **template functions** that accept an array of runtime provider descriptions and inject them into the appropriate location:

```typescript
export const TOOL_DESCRIPTION = (runtimeProviderDescriptions: string[]) => `
# Tool Name

## When to Use
...

## Available Functions
${runtimeProviderDescriptions.join("\n\n")}
`;
```

The descriptions from runtime providers are **dynamically injected** so the LLM knows what functions are available in that tool's execution context.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         Agent Initialization                     │
│                      (sidepanel.ts:304-349)                     │
└──────────────────────┬──────────────────────────────────────────┘
                       │
           ┌───────────┴──────────┐
           │                      │
           ▼                      ▼
    ┌──────────┐          ┌──────────────┐
    │  Tools   │          │  Runtime     │
    │          │          │  Providers   │
    └──────────┘          └──────────────┘
           │                      │
           │                      │
    ┌──────┴──────────────────────┴──────┐
    │                                     │
    ▼                                     ▼
┌────────────────┐              ┌──────────────────┐
│ Tool           │              │ Provider         │
│ Description    │◄─────────────│ getDescription() │
│ (template fn)  │   injected   │                  │
└────────────────┘              └──────────────────┘
```

## Current Prompts

### Local Prompt Modules

`src/prompts/prompts.ts` defines `SYSTEM_PROMPT`, descriptions for `repl`, `skill`, `navigate`, and `ask_user_which_element`, plus descriptions for browser JavaScript, navigation, and trusted native-input helpers. Reusable descriptions are in nearby local modules: `src/prompts/attachments.ts` describes attachment helpers, and `src/prompts/artifacts.ts` describes the artifacts tool and its read/write runtime APIs. `src/tools/extract-document.ts` owns the document-extraction tool description and behavior.

## Implementation Details

### How Runtime Providers Work

#### 1. Provider Implementation

`ArtifactsRuntimeProvider` in `src/artifacts/ArtifactsRuntimeProvider.ts` returns a serializable artifact snapshot, installs sandbox helpers, documents them via `getDescription()`, and handles artifact-operation messages. Its read-only mode documents reads only and rejects write/delete requests in the message handler; the helper functions still exist in the sandbox. The local interface is:

```typescript
interface SandboxRuntimeProvider {
  getData(): Record<string, unknown>;
  getRuntime(): (sandboxId: string) => void;
  getDescription(): string;
  handleMessage?(message: RuntimeMessage, respond: (response: RuntimeResponse) => void): Promise<void>;
  onExecutionStart?(sandboxId: string, signal?: AbortSignal): void;
  onExecutionEnd?(sandboxId: string): void;
}
```

#### 2. Tool Registration with Provider Injection
`createReplTool()` in `src/tools/repl/repl.ts` uses a description getter. `ArtifactsPanel.get tool()` in `src/artifacts/ArtifactsPanel.ts` builds the artifact description from its current providers.

```typescript
description: ARTIFACTS_TOOL_DESCRIPTION(
  this.providers().map((provider) => provider.getDescription()),
),
```

The REPL description getter calls its `runtimeProvidersFactory()`, collects non-empty `getDescription()` values, and passes them to `REPL_TOOL_DESCRIPTION`. The artifacts tool computes its description from the providers created by the panel. Keep the prompt text and provider list aligned so the model is told only about helpers available in that execution context.

#### 3. Provider Composition in Sidepanel
`src/sidepanel.ts` composes providers for the REPL:

```typescript
replTool.runtimeProvidersFactory = () => {
    const pageProviders = [
        ...runtimeProvidersFactory(),
        new NativeInputEventsRuntimeProvider(),
    ];

    return [
        ...pageProviders,
        new BrowserJsRuntimeProvider(pageProviders),
        new NavigateRuntimeProvider(navigateTool),
    ];
};
```

This composition ensures:
- Base providers (attachments, artifacts) are available everywhere
- Page-specific providers (native input events) are available via `browserjs()`
- REPL-specific providers (browserjs, navigate) are available in REPL context

### How Descriptions Flow Through the System

```
1. Provider defines getDescription()
   └─> Returns description string

2. The tool creates or obtains provider instances
   └─> REPL calls its provider factory when its description getter runs
   └─> ArtifactsPanel supplies providers while constructing its tool

3. Tool description getter collects descriptions
   └─> Calls getDescription() on each provider
   └─> Filters empty strings
   └─> Passes array to template function

4. Template function injects descriptions
   └─> Uses ${runtimeProviderDescriptions.join("\n\n")}
   └─> Returns complete tool description

5. Agent uses tool description
   └─> Tool description sent to LLM with prompt
   └─> LLM knows what functions are available
```

## Runtime Provider Descriptions Pattern

All provider descriptions must follow this optimized pattern:

```markdown
### Provider Name

Brief one-sentence summary of what these functions provide.

#### When to Use
- Bullet point describing use case
- Another use case

#### Do NOT Use For (optional - only include if critical)
- Negative case that would cause serious issues

#### Functions
- functionName(params) - Brief description, returns type
- anotherFunction(params) - Brief description, returns type

#### Example
Complete workflow example showing typical usage:
\`\`\`javascript
const data = await someFunction();
await anotherFunction(data);
\`\`\`
```

**Key requirements**:
- Start with `###` heading for provider name
- Add one-sentence summary immediately after heading
- Use `####` subheadings for: "When to Use", "Functions", "Example"
- List functions with parameter and return type info ONLY (no inline examples - save tokens)
- End with complete workflow example in code block showing real usage
- Keep "Do NOT Use For" section minimal or omit if not critical
- Keep descriptions minimal (token efficiency is critical)

## Tool Description Pattern

All tool descriptions must follow this optimized pattern:

```markdown
# Tool Name

Brief one-sentence summary of what the tool does.

## When to Use
- Use case 1 (prioritize most common use case first)
- Use case 2
- Use case 3

## Environment (for execution tools like REPL)
- What execution context
- What APIs are available
- What libraries can be imported

## Input
Show concrete examples of how to call the tool:
- { action: "create", filename: "notes.md", content: "..." } - Brief description
- { action: "update", filename: "notes.md", old_str: "...", new_str: "..." } - Brief description
- { action: "get", filename: "data.json" } - Brief description

## Returns
What the tool returns (success status, content, errors, etc.)

## Helper Functions (Automatically Available)

These functions are injected into the execution environment and available globally:

${runtimeProviderDescriptions.join("\n\n")}
```

**Key requirements**:
- Use `#` for main heading, `##` for sections
- Start with brief one-sentence summary (NOT a separate ## Purpose section)
- Include "When to Use" section with prioritized use cases
- **## Input section shows CONCRETE EXAMPLES** of parameters, not abstract descriptions
- Include "## Returns" section describing output
- Remove verbose "## Output" and "## Important Notes" sections - integrate into other sections
- End with "Helper Functions (Automatically Available)" for runtime provider injection (if applicable)
- Keep minimal (token efficiency is critical)

**Action Naming Conventions**:
For tools that manipulate content (artifacts, skills), use consistent action names:
- **update**: String replacement for targeted edits (`old_string` → `new_string`) - PREFERRED for token efficiency
- **rewrite**: Full replacement of entire fields - LAST RESORT when update won't work
- **create**: Create new items
- **get**: Retrieve items
- **delete**: Delete items
- **list**: List available items


## Guidelines for Adding/Modifying Prompts

### When Adding a New Tool

1. **Choose the right location**:
   - Sitegeist tool prompts → `src/prompts/prompts.ts` or the focused local description module for that tool.
   - Runtime helper descriptions → the `src/prompts/` module imported by their provider.

2. **Follow the tool description pattern** (see above)

3. **If the tool uses runtime providers**:
   - Make description a template function: `(runtimeProviderDescriptions: string[]) => string`
   - End with "## Helper Functions (Automatically Available)" section
   - Inject providers: `${runtimeProviderDescriptions.join("\n\n")}`

4. **Implement the tool**:
   - If using providers, make `description` a getter that calls `runtimeProvidersFactory()`
   - See Implementation Details section for examples

### When Adding a Runtime Provider

1. **Implement the provider class**:
   - Implement `SandboxRuntimeProvider` interface
   - Implement the required `getData()`, `getRuntime()`, and `getDescription()` methods from `src/sandbox/types.ts`.
   - Add `handleMessage()` or execution lifecycle hooks only when the provider needs them.

2. **Write the provider description** following the pattern above

3. **Register the provider** in tool's `runtimeProvidersFactory`

### When Modifying Existing Prompts

1. **Follow existing patterns** - use same header structure, action names, formatting
2. **Keep token efficiency in mind**:
   - Remove redundant examples (one complete workflow example is better than many inline examples)
   - Use concrete examples in ## Input rather than abstract descriptions
   - Minimize "Do NOT Use For" sections - only include critical negative cases
3. **Use consistent action naming**:
   - `update` for string replacement (preferred)
   - `rewrite` for full replacement (last resort)
   - `create`, `get`, `delete`, `list` where applicable

### Writing Style

- **Be explicit**: "ALWAYS use X", "NEVER use Y"
- **Use active voice**: "Click the button" not "The button should be clicked"
- **Give concrete examples with code**
- **State consequences**: "If you do X, Y will happen"
- **Avoid "you should" or "it's recommended"** - be direct

### Testing Changes

After updating prompts:
1. Run `./check.sh` to verify no TypeScript errors
2. Test with actual agent - does it follow instructions?
3. Check edge cases - does it handle errors correctly?
4. Verify terminology is consistent across all prompts

## References

### Key Files

**Interfaces**:
- [Sandbox provider and message contracts](../src/sandbox/types.ts)

**Prompt Definitions**:
- [System and core tool prompts](../src/prompts/prompts.ts)
- [Attachment helper description](../src/prompts/attachments.ts)
- [Artifact tool and runtime descriptions](../src/prompts/artifacts.ts)

**Provider Implementations**:
- [Artifacts provider](../src/artifacts/ArtifactsRuntimeProvider.ts)
- [Attachments provider](../src/attachments/AttachmentsRuntimeProvider.ts)
- [Native input events provider](../src/tools/NativeInputEventsRuntimeProvider.ts)
- [BrowserJS and navigate providers](../src/tools/repl/runtime-providers.ts)

**Tool Implementations**:
- [Artifacts tool composition](../src/artifacts/ArtifactsPanel.ts)
- [REPL tool](../src/tools/repl/repl.ts)

**Integration**:
- [Agent, tool, and provider composition](../src/sidepanel.ts)

### Related Documentation
- `docs/tool-renderers.md` - How tool invocations are rendered in UI
- `docs/storage.md` - Storage architecture
- `docs/skills.md` - Skill system (auto-inject libraries into browserjs)
