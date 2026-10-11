# Storage Architecture

## Overview

Sitegeist uses a unified IndexedDB storage system with multiple object stores for different data types. The complete storage infrastructure is implemented in Sitegeist under `src/storage/`.

## Current Implementation

Single IndexedDB database `sitegeist-storage` (schema version 3) with multiple object stores:

**Core stores** (Sitegeist-owned):
- `sessions` - Full session data (messages, model, thinking level)
- `sessions-metadata` - Lightweight session metadata (title, timestamps, usage)
- `settings` - Application settings (key-value pairs)
- `provider-keys` - API keys for LLM providers

**Additional Sitegeist stores**:
- `skills` - Skill definitions with library code
- `custom-providers` - User-defined provider configurations
- `daily_costs` - Per-day provider/model cost aggregates

**Benefits**:
- **Quota**: Uses browser-managed IndexedDB quota; query it through the backend rather than assuming a fixed limit
- **Consistency**: Single API, unified transactions
- **Performance**: IndexedDB indices for efficient queries
- **Atomic operations**: Multi-store transactions
- **Extensibility**: Add stores without creating new databases

## Architecture

### StorageBackend Interface

Location: `src/storage/types.ts`

```typescript
export interface StorageBackend {
  // Basic operations
  get<T>(storeName: string, key: string): Promise<T | null>;
  set<T>(storeName: string, key: string, value: T): Promise<void>;
  delete(storeName: string, key: string): Promise<void>;
  keys(storeName: string, prefix?: string): Promise<string[]>;
  clear(storeName: string): Promise<void>;
  has(storeName: string, key: string): Promise<boolean>;

  // Index-based queries
  getAllFromIndex<T>(
    storeName: string,
    indexName: string,
    direction?: 'asc' | 'desc'
  ): Promise<T[]>;

  // Atomic transactions across stores
  transaction<T>(
    storeNames: string[],
    mode: 'readonly' | 'readwrite',
    operation: (tx: StorageTransaction) => Promise<T>
  ): Promise<T>;

  // Quota management
  getQuotaInfo(): Promise<{ usage: number; quota: number; percent: number }>;
  requestPersistence(): Promise<boolean>;
}
```

### IndexedDBStorageBackend

Location: `src/storage/backends/indexeddb-storage-backend.ts`

Implements the `StorageBackend` interface using IndexedDB APIs.

**Key features**:
- Configuration-driven object store creation
- Automatic index creation from config
- Lazy database initialization with `onupgradeneeded`
- Promisified IDBRequest API
- Efficient prefix queries with `IDBKeyRange`
- Index-based iteration with cursors

**Example usage**:
```typescript
const backend = new IndexedDBStorageBackend({
  dbName: 'sitegeist-storage',
  version: 1,
  stores: [
    {
      name: 'sessions',
      keyPath: 'id',
      indices: [{ name: 'lastModified', keyPath: 'lastModified' }]
    }
  ]
});
```

### Store Pattern

Location: `src/storage/store.ts`

Base class for all stores:

```typescript
export abstract class Store {
  private backend?: StorageBackend;

  abstract getConfig(): StoreConfig;

  setBackend(backend: StorageBackend): void {
    this.backend = backend;
  }

  protected getBackend(): StorageBackend {
    if (!this.backend) {
      throw new Error("Storage backend has not been initialized");
    }
    return this.backend;
  }
}
```

**Benefits**:
- Each store owns its schema configuration
- No circular dependencies
- Type-safe domain-specific methods
- Extensible via subclassing
- Testable with mocked backend

## Core Stores (Sitegeist)

### SettingsStore

Location: `src/storage/stores/settings-store.ts`

Simple key-value store for application settings.

```typescript
export class SettingsStore extends Store {
  getConfig(): StoreConfig {
    return { name: 'settings' };
  }

  async get<T>(key: string): Promise<T | null>
  async set<T>(key: string, value: T): Promise<void>
  async delete(key: string): Promise<void>
  async list(): Promise<string[]>
  async clear(): Promise<void>
}
```

### ProviderKeysStore

Location: `src/storage/stores/provider-keys-store.ts`

Stores API keys for LLM providers (Anthropic, OpenAI, etc).

```typescript
export class ProviderKeysStore extends Store {
  getConfig(): StoreConfig {
    return { name: 'provider-keys' };
  }

  async get(provider: string): Promise<string | null>
  async set(provider: string, apiKey: string): Promise<void>
  async delete(provider: string): Promise<void>
  async list(): Promise<string[]>
  async has(provider: string): Promise<boolean>
}
```

### SessionsStore

Location: `src/storage/stores/base-sessions-store.ts`

Manages chat sessions using two object stores for performance:
- `sessions` - Full session data (large, rarely listed)
- `sessions-metadata` - Lightweight metadata (for listing UI)

```typescript
export class SessionsStore extends Store {
  getConfig(): StoreConfig {
    return {
      name: 'sessions',
      keyPath: 'id',
      indices: [{ name: 'lastModified', keyPath: 'lastModified' }]
    };
  }

  static getMetadataConfig(): StoreConfig {
    return {
      name: 'sessions-metadata',
      keyPath: 'id',
      indices: [{ name: 'lastModified', keyPath: 'lastModified' }]
    };
  }

  // Atomic save to both stores
  async save(data: SessionData, metadata: SessionMetadata): Promise<void> {
    await this.getBackend().transaction(
      ['sessions', 'sessions-metadata'],
      'readwrite',
      async (tx) => {
        await tx.set('sessions', data.id, data);
        await tx.set('sessions-metadata', metadata.id, metadata);
      }
    );
  }

  // Efficient query using index
  async getAllMetadata(): Promise<SessionMetadata[]> {
    return this.getBackend().getAllFromIndex<SessionMetadata>(
      'sessions-metadata',
      'lastModified',
      'desc'
    );
  }

  async getLatestSessionId(): Promise<string | null> {
    const allMetadata = await this.getAllMetadata();
    return allMetadata[0]?.id ?? null;
  }
}
```

**Why two stores?**
- Session list UI needs fast metadata access (title, date, message count)
- Loading full session data (all messages, artifacts) is slow
- Separation allows efficient listing without loading full content

**Index usage**:
- `lastModified` index enables sorted queries via IndexedDB cursor
- Much faster than fetching all keys and sorting in JavaScript

### SitegeistSessionsStore

`src/storage/stores/sessions-store.ts` extends the base session store. Its `saveSession(id, state, metadata, title?)` helper saves the agent state and metadata together. Its `get()` and `loadSession()` readers convert legacy tool-result records with a string `output` and no `content` into text-content blocks in the returned value; this compatibility conversion does not rewrite the IndexedDB record.

## Extension Stores (Sitegeist)

### SkillsStore

Location: `src/storage/stores/skills-store.ts`

Stores skill definitions including library code.

```typescript
export class SkillsStore extends Store {
  getConfig(): StoreConfig {
    return { name: 'skills' };
  }

  async save(skill: Skill): Promise<void>
  async get(name: string): Promise<Skill | null>
  async delete(name: string): Promise<void>
  async list(): Promise<Skill[]>
}
```

**Key fields**:
- `name` - Unique skill identifier
- `domainPatterns` - URL patterns where skill applies
- `shortDescription` - Brief description of the skill
- `description` - Detailed description (markdown supported)
- `library` - JavaScript code to inject
- `examples` - Example usage code
- `createdAt` - Timestamp when skill was created
- `lastUpdated` - Timestamp when skill was last modified

### CustomProvidersStore and CostStore

`CustomProvidersStore` persists user-defined providers by ID in `custom-providers`. It exposes `get`, `set`, `delete`, `has`, and `getAll`; provider records can include a custom API key and model list.

`CostStore` persists daily aggregates in `daily_costs`, keyed and indexed by date. `recordCost()` uses a read/write transaction to update daily total and provider/model subtotals atomically. The store also provides newest-first listing, total/provider/model summaries, and date-range filtering.

## AppStorage Wiring

### AppStorage (Sitegeist)

Location: `src/storage/app-storage.ts`

`AppStorage` exposes the shared stores `settings`, `providerKeys`, `sessions`, `customProviders`, and `backend`, plus `getQuotaInfo()` and `requestPersistence()`. `SitegeistAppStorage` adds `skills` and `costs` and creates the IndexedDB backend for database `sitegeist-storage`, schema version 3.

**Initialization order**:
1. Instantiate the domain stores.
2. Gather each store's schema configuration, including the `sessions-metadata` config.
3. Create one `IndexedDBStorageBackend` with the database name, version, and all configurations.
4. Wire each store to that backend.
5. Expose the stores through `SitegeistAppStorage`.

`getAppStorage()` returns the initialized singleton set by `setAppStorage()`. `getSitegeistStorage()` returns it only when it is a `SitegeistAppStorage`; it throws if storage has not been initialized or is the base `AppStorage` type.

## Usage Examples

### Saving a Session

```typescript
const storage = getAppStorage();

const sessionData: SessionData = {
  id: crypto.randomUUID(),
  title: 'My Session',
  model: agent.state.model,
  thinkingLevel: agent.state.thinkingLevel,
  messages: agent.state.messages,
  createdAt: new Date().toISOString(),
  lastModified: new Date().toISOString(),
};

const metadata: SessionMetadata = {
  id: sessionData.id,
  title: sessionData.title,
  createdAt: sessionData.createdAt,
  lastModified: sessionData.lastModified,
  messageCount: sessionData.messages.length,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  modelId: sessionData.model.id,
  thinkingLevel: sessionData.thinkingLevel,
  preview: '',
};

// Atomic save to both stores
await storage.sessions.save(sessionData, metadata);
```

### Loading Sessions (Sorted by Date)

```typescript
const storage = getAppStorage();

// Uses lastModified index - pre-sorted by database
const sessions = await storage.sessions.getAllMetadata();

// sessions is now sorted newest-first without any JS sorting!
```

### Managing Skills

```typescript
const storage = getSitegeistStorage();

// Save a skill
await storage.skills.save({
  name: 'gmail-search',
  domainPatterns: ['mail.google.com/**'],
  shortDescription: 'Search Gmail messages',
  description: 'Comprehensive Gmail search functionality',
  library: 'window.gmail = { search: function(query) { ... } }',
  examples: '// Search for emails\nconst results = gmail.search("from:boss");',
  createdAt: new Date().toISOString(),
  lastUpdated: new Date().toISOString(),
});

// Load skill by name
const skill = await storage.skills.get('gmail-search');

// List all skills
const allSkills = await storage.skills.list();

// Get skills for a specific URL
const matchingSkills = await storage.skills.getSkillsForUrl('https://mail.google.com/mail/u/0/#inbox');
```

## Quota Management

### Checking Storage Usage

```typescript
const storage = getAppStorage();
const quota = await storage.getQuotaInfo();

console.log(`Using ${quota.usage} bytes of ${quota.quota} bytes`);
console.log(`${quota.percent.toFixed(1)}% full`);

if (quota.percent > 80) {
  alert('Running out of storage!');
}
```

### Requesting Persistent Storage

```typescript
const storage = getAppStorage();

// Prevents browser from evicting data
const granted = await storage.requestPersistence();

if (granted) {
  console.log('Persistent storage was granted');
} else {
  console.log('User denied persistence request');
}
```

**Note**: Quota and persistence behavior is controlled by the browser; check the returned values rather than assuming a fixed quota or automatic grant.

### Inspecting IndexedDB

Chrome DevTools → Application → IndexedDB → `sitegeist-storage`

- View all object stores
- Inspect indices
- Query data manually
- Check index usage

## Performance Considerations

### When to Use Indices

**Good use cases**:
- Sorting large datasets (sessions by date)
- Range queries (sessions between dates)
- Frequent lookups on non-primary key

**Bad use cases**:
- Small datasets (<100 items)
- Single-item lookups by primary key
- Write-heavy workloads (indices slow down writes)

### Session Metadata Separation

Loading session list with full data:
```
❌ Slow: 1000 sessions × 100KB each = 100MB to transfer
```

Loading session list with metadata only:
```
✅ Fast: 1000 sessions × 1KB each = 1MB to transfer
```

### Prefix Queries vs Full Scan

Getting items with a specific prefix:

```typescript
// ❌ Slow: Full scan
const allKeys = await backend.keys('skills');
const filteredKeys = allKeys.filter(k => k.startsWith('google-'));

// ✅ Fast: Prefix query with IDBKeyRange
const keys = await backend.keys('skills', 'google-');
```

## Future Extensions

### Additional Indices

Add to `sessions-metadata`:
```typescript
{ name: 'createdAt', keyPath: 'createdAt' }
{ name: 'messageCount', keyPath: 'messageCount' }
```

Enables queries like:
- Sessions created this week
- Sessions with >50 messages

### Compound Indices

```typescript
{ name: 'modelAndDate', keyPath: ['modelId', 'lastModified'] }
```

Query all Claude Sonnet sessions sorted by date.

### Remote Sync Backend

```typescript
export class RemoteSyncBackend implements StorageBackend {
  async get(storeName: string, key: string) {
    // Fetch from local IndexedDB first
    // Sync with remote API in background
  }

  async set(storeName: string, key: string, value: T) {
    // Save to local IndexedDB immediately
    // Queue remote sync
  }
}
```

### Export/Import

```typescript
export class DataExporter {
  async exportAll(): Promise<ExportData> {
    const data: ExportData = {};
    for (const storeName of storeNames) {
      data[storeName] = await backend.getAllFromIndex(
        storeName,
        'id',
        'asc'
      );
    }
    return data;
  }

  async importAll(data: ExportData): Promise<void> {
    // Validate schema
    // Import with transactions
  }
}
```

## Related Files

### Core Storage (Sitegeist)
- [types.ts](../src/storage/types.ts) - Interfaces and types
- [store.ts](../src/storage/store.ts) - Base Store class
- [app-storage.ts](../src/storage/app-storage.ts) - AppStorage and SitegeistAppStorage
- [backends/indexeddb-storage-backend.ts](../src/storage/backends/indexeddb-storage-backend.ts) - IndexedDB implementation

### Store Implementations (Sitegeist)
- [stores/settings-store.ts](../src/storage/stores/settings-store.ts)
- [stores/provider-keys-store.ts](../src/storage/stores/provider-keys-store.ts)
- [stores/base-sessions-store.ts](../src/storage/stores/base-sessions-store.ts)
- [Sitegeist session compatibility reader](../src/storage/stores/sessions-store.ts)

### Extension Storage (sitegeist)
- [app-storage.ts](../src/storage/app-storage.ts) - SitegeistAppStorage
- [stores/skills-store.ts](../src/storage/stores/skills-store.ts) - Skills repository
