import type { Table } from "dexie";
import { LRUCache } from "typescript-lru-cache";

export type WarmUpFunction<T> = (cacheHandler: CacheHandler<T>, debug: debug.IDebugger) => Promise<void>;

export interface CacheOptions<T> {
    maxSize: number;
    dump: (dirtyKeys: Set<string>, cache: LRUCache<string, T>) => Promise<void>;
    debug: debug.IDebugger;
    /** Entries written per IndexedDB batch; the write yields to the event loop between batches. */
    dumpChunkSize?: number;
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export class CacheHandler<T> {
    private cache?: LRUCache<string, T>;
    private dirtyKeys: Set<string> = new Set();
    private options: CacheOptions<T>;
    private debug: debug.IDebugger;
    public indexes: Map<string | number, LRUCache<string | number, Set<string>>>;
    public isSet = false;
    public maxSize = 0;
    private dumping = false;

    constructor(options: CacheOptions<T>) {
        this.debug = options.debug;
        this.options = options;
        this.maxSize = options.maxSize;
        if (options.maxSize > 0) {
            this.cache = new LRUCache({ maxSize: options.maxSize });
            setInterval(() => this.dump().catch(console.error), 1000 * 10);
        }

        this.indexes = new Map();
    }

    public getSet(key: string): Set<T> | null {
        return this.cache?.get(key) as Set<T> | null;
    }

    /**
     * Get all entries that match the filter.
     */
    public getAllWithFilter(filter: (key: string, val: T) => boolean): Map<string, T> {
        const ret = new Map<string, T>();
        this.cache?.forEach((val, key) => {
            if (filter(key, val)) {
                ret.set(key, val);
            }
        });
        return ret;
    }

    public get(key: string): T | null | undefined {
        return this.cache?.get(key);
    }

    public async getWithFallback(key: string, table: Table) {
        let entry = this.get(key);
        if (!entry) {
            entry = await table.get(key);
            if (entry) {
                // this.debug(`Cache miss for key ${JSON.stringify(key)}`);
                this.set(key, entry);
            }
        }
        return entry;
    }

    public async getManyWithFallback(keys: string[], table: Table) {
        const entries: T[] = [];
        const missingKeys: string[] = [];
        // get all entries from cache without hitting the database
        for (const key of keys) {
            const entry = this.get(key);
            if (entry) entries.push(entry);
            else missingKeys.push(key);
        }

        if (entries.length > 0) {
            this.debug(`Cache hit for keys ${entries.length} and miss for ${missingKeys.length} keys`);
        }

        // get missing entries from the database
        if (missingKeys.length > 0) {
            const startTime = Date.now();
            const missingEntries = await table.bulkGet(missingKeys);
            const endTime = Date.now();
            let foundKeys = 0;

            for (const entry of missingEntries) {
                if (entry) {
                    this.set(entry.id, entry);
                    entries.push(entry);
                    foundKeys++;
                }
            }
            this.debug(
                `Time spent querying database: ${endTime - startTime}ms for ${
                    missingKeys.length
                } keys, which added ${foundKeys} entries to the cache`,
            );
        }

        return entries;
    }

    public add<K>(key: string, value: K, dirty = true) {
        const existing = this.get(key) ?? new Set<K>();
        (existing as Set<K>).add(value);
        this.cache?.set(key, existing as T);

        if (dirty) this.dirtyKeys.add(key);
    }

    public set(key: string, value: T, dirty = true) {
        this.cache?.set(key, value);
        if (dirty) this.dirtyKeys.add(key);

        // update indexes
        for (const [attribute, index] of this.indexes.entries()) {
            const indexKey = (value as any)[attribute] as string;
            if (indexKey) {
                const indexValue = index.get(indexKey) || new Set<string>();
                indexValue.add(key);
                index.set(indexKey, indexValue);
            }
        }
    }

    public size(): number {
        return this.cache?.size || 0;
    }

    public delete(key: string) {
        this.cache?.delete(key);
        this.dirtyKeys.add(key);
    }

    /**
     * Writes the entries changed since the last write, in batches so a large backlog
     * doesn't block the main thread. Entries changed while writing stay dirty for the
     * next write; entries whose batch failed are retried.
     */
    private async dump() {
        if (this.dumping || this.dirtyKeys.size === 0 || !this.cache) return;
        this.dumping = true;
        const keys = Array.from(this.dirtyKeys);
        this.dirtyKeys.clear();
        const chunkSize = this.options.dumpChunkSize ?? 50;
        let written = 0;
        try {
            for (; written < keys.length; written += chunkSize) {
                if (written > 0) await yieldToEventLoop();
                await this.options.dump(new Set(keys.slice(written, written + chunkSize)), this.cache);
            }
        } catch (e) {
            for (const key of keys.slice(written)) this.dirtyKeys.add(key);
            throw e;
        } finally {
            this.dumping = false;
        }
    }

    public addIndex<_T>(attribute: string | number) {
        this.indexes.set(attribute, new LRUCache({ maxSize: this.options.maxSize }));
    }

    public getFromIndex(index: string, key: string | number) {
        const ret = new Set<T>();
        const indexValues = this.indexes.get(index);
        if (indexValues) {
            const values = indexValues.get(key);

            if (values) {
                for (const key of values.values()) {
                    const entry = this.get(key);
                    if (entry) ret.add(entry as T);
                }
            }
        }

        return ret;
    }
}
