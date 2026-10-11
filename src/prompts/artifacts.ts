export function artifactsRuntimeDescription(readWrite: boolean): string {
	return `### Artifacts Storage
${readWrite ? "Create, read, update, and delete files in artifacts storage. Use it to store intermediate results or generated files; use the artifacts tool for content you author directly." : "Read files from artifacts storage. HTML artifacts have read-only access; creating or modifying artifacts is not available."}
- listArtifacts() — returns Promise<string[]> of filenames
- getArtifact(filename) — returns Promise<string | object>; .json files auto-parse, binary files return base64 strings
${readWrite ? "- createOrUpdateArtifact(filename, content, mimeType?) — returns Promise<void>; objects serialize as JSON, binary content requires a base64 string\n- deleteArtifact(filename) — returns Promise<void>" : ""}`;
}

export const ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RO = artifactsRuntimeDescription(false);
export const ARTIFACTS_RUNTIME_PROVIDER_DESCRIPTION_RW = artifactsRuntimeDescription(true);

export const ARTIFACTS_TOOL_DESCRIPTION = (runtimeDescriptions: string[]) =>
	`Create and manage persistent files alongside the conversation. Use this tool to author notes, analysis, Markdown, HTML applications, SVG, text, code and data. Use REPL artifact storage helpers when code processes data or generates binary PDF, DOCX, Excel or image files.

Commands: create(filename, content), update(filename, old_str, new_str), rewrite(filename, content), get(filename), delete(filename), logs(filename). Prefer targeted update over rewriting the entire file. Update replaces the first occurrence of old_str. Binary file content is base64.

HTML artifacts are self-contained interactive documents in an isolated sandbox. Set a background color and use responsive layouts. ES modules from esm.sh and Tailwind CDN are supported. No localStorage/sessionStorage. Artifacts can read other artifacts and user attachments but cannot create or modify them. Downloads embed snapshots for standalone offline use.

${runtimeDescriptions.join("\n")}`;
