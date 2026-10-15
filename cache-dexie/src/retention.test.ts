import { describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import NDKCacheAdapterDexie from "./index.js";
import { CacheHandler } from "./lru-cache.js";

const day = 24 * 60 * 60;
const now = Math.floor(Date.now() / 1000);

async function seededAdapter() {
    const adapter = new NDKCacheAdapterDexie({ dbName: `retention-${Math.random()}` });
    await (adapter as any).warmUpPromise;
    const row = (id: string, kind: number, createdAt: number) => ({
        id,
        pubkey: "p",
        kind,
        createdAt,
        relay: "",
        event: "{}",
    });
    await db.events.bulkPut([row("old-note", 1, now - 100 * day), row("new-note", 1, now), row("old-profile", 0, now - 100 * day)]);
    await db.eventTags.bulkPut([
        { tagValue: "p:x", eventId: "old-note" },
        { tagValue: "p:x", eventId: "new-note" },
    ]);
    await db.eventRelays.bulkPut([{ eventId: "old-note", relayUrl: "wss://r/", seenAt: now }]);
    return adapter;
}

describe("deleteEventIds", () => {
    it("deletes the events and everything stored about them", async () => {
        const adapter = await seededAdapter();
        await adapter.deleteEventIds(["old-note", "old-profile"]);

        expect((await db.events.toArray()).map((e) => e.id)).toEqual(["new-note"]);
        expect(await db.eventTags.toArray()).toEqual([{ tagValue: "p:x", eventId: "new-note" }]);
        expect(await db.eventRelays.count()).toBe(0);
    });
});

describe("prune", () => {
    it("deletes events of the given kinds older than the cutoff", async () => {
        const adapter = await seededAdapter();
        const deleted = await adapter.prune({ kinds: [1], before: now - 90 * day });

        expect(deleted).toBe(1);
        expect((await db.events.toArray()).map((e) => e.id).sort()).toEqual(["new-note", "old-profile"]);
        expect(await db.eventTags.where("eventId").equals("old-note").count()).toBe(0);
    });
});

describe("CacheHandler write-back", () => {
    const handler = (dump: (keys: Set<string>) => Promise<void>, chunk?: number) =>
        new CacheHandler<string>({ maxSize: 1000, dump, debug: (() => {}) as any, dumpChunkSize: chunk });

    it("writes dirty entries in chunks", async () => {
        const writes: number[] = [];
        const h = handler(async (keys) => {
            writes.push(keys.size);
        }, 50);
        for (let i = 0; i < 120; i++) h.set(`k${i}`, "v");
        await (h as any).dump();
        expect(writes).toEqual([50, 50, 20]);
    });

    it("keeps entries changed during a write for the next one", async () => {
        const written: string[][] = [];
        let h!: CacheHandler<string>;
        h = handler(async (keys) => {
            written.push([...keys]);
            if (written.length === 1) h.set("late", "v");
        });
        h.set("first", "v");
        await (h as any).dump();
        await (h as any).dump();
        expect(written).toEqual([["first"], ["late"]]);
    });

    it("retries entries whose write failed", async () => {
        const dump = vi.fn().mockRejectedValueOnce(new Error("quota")).mockResolvedValue(undefined);
        const h = handler(dump);
        h.set("a", "v");
        await expect((h as any).dump()).rejects.toThrow("quota");
        await (h as any).dump();
        expect([...dump.mock.calls[1][0]]).toEqual(["a"]);
    });
});
