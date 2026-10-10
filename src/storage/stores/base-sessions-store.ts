import type { AgentState } from "../../pi/agent.js";
import { Store } from "../store.js";
import type { SessionData, SessionMetadata, StoreConfig } from "../types.js";

export class SessionsStore extends Store {
	getConfig(): StoreConfig {
		return { name: "sessions", keyPath: "id", indices: [{ name: "lastModified", keyPath: "lastModified" }] };
	}

	static getMetadataConfig(): StoreConfig {
		return { name: "sessions-metadata", keyPath: "id", indices: [{ name: "lastModified", keyPath: "lastModified" }] };
	}

	save(data: SessionData, metadata: SessionMetadata): Promise<void> {
		if (data.id !== metadata.id) return Promise.reject(new Error("Session and metadata IDs must match"));
		return this.getBackend().transaction(["sessions", "sessions-metadata"], "readwrite", async (tx) => {
			await tx.set("sessions", data.id, data);
			await tx.set("sessions-metadata", metadata.id, metadata);
		});
	}

	get(id: string): Promise<SessionData | null> {
		return this.getBackend().get("sessions", id);
	}
	getMetadata(id: string): Promise<SessionMetadata | null> {
		return this.getBackend().get("sessions-metadata", id);
	}
	getAllMetadata(): Promise<SessionMetadata[]> {
		return this.getBackend().getAllFromIndex("sessions-metadata", "lastModified", "desc");
	}

	delete(id: string): Promise<void> {
		return this.getBackend().transaction(["sessions", "sessions-metadata"], "readwrite", async (tx) => {
			await tx.delete("sessions", id);
			await tx.delete("sessions-metadata", id);
		});
	}

	deleteSession(id: string): Promise<void> {
		return this.delete(id);
	}

	updateTitle(id: string, title: string): Promise<void> {
		return this.getBackend().transaction(["sessions", "sessions-metadata"], "readwrite", async (tx) => {
			const data = await tx.get<SessionData>("sessions", id);
			const metadata = await tx.get<SessionMetadata>("sessions-metadata", id);
			if (data) await tx.set("sessions", id, { ...data, title });
			if (metadata) await tx.set("sessions-metadata", id, { ...metadata, title });
		});
	}

	getQuotaInfo() {
		return this.getBackend().getQuotaInfo();
	}
	requestPersistence(): Promise<boolean> {
		return this.getBackend().requestPersistence();
	}

	async saveSession(
		id: string,
		state: AgentState,
		metadata: SessionMetadata | undefined,
		title?: string,
	): Promise<void> {
		const now = new Date().toISOString();
		const sessionTitle = title ?? metadata?.title ?? "";
		const createdAt = metadata?.createdAt ?? now;
		await this.save(
			{
				id,
				title: sessionTitle,
				model: state.model,
				thinkingLevel: state.thinkingLevel,
				messages: state.messages,
				createdAt,
				lastModified: now,
			},
			metadata ?? {
				id,
				title: sessionTitle,
				createdAt,
				lastModified: now,
				messageCount: state.messages.length,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				thinkingLevel: state.thinkingLevel,
				preview: "",
			},
		);
	}

	loadSession(id: string): Promise<SessionData | null> {
		return this.get(id);
	}
	async getLatestSessionId(): Promise<string | null> {
		return (await this.getAllMetadata())[0]?.id ?? null;
	}
}
