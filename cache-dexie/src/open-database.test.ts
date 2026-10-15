import Dexie from "dexie";
import { describe, expect, it } from "vitest";
import { createDatabase, db, openDatabase } from "./db.js";

describe("openDatabase", () => {
    it("recreates a database whose schema can't be upgraded in place", async () => {
        const name = `legacy-${Math.random()}`;
        // Shape written by adapter 2.6.x: eventTags keyed by tagValue alone.
        const legacy = new Dexie(name);
        legacy.version(15).stores({ events: "&id, kind", eventTags: "&tagValue" });
        await legacy.open();
        await legacy.table("events").put({ id: "a", kind: 1 });
        legacy.close();

        createDatabase(name);
        await openDatabase();

        expect(db.verno).toBe(20);
        expect(await db.events.count()).toBe(0);
        await db.eventTags.put({ tagValue: "p:x", eventId: "a" });
        expect(await db.eventTags.count()).toBe(1);
    });

    it("keeps data when the schema upgrades cleanly", async () => {
        const name = `current-${Math.random()}`;
        createDatabase(name);
        await openDatabase();
        await db.events.put({ id: "b", kind: 1 } as never);
        db.close();

        createDatabase(name);
        await openDatabase();
        expect(await db.events.count()).toBe(1);
    });

    it("adds the eventTags eventId index to a schema-19 cache without dropping data", async () => {
        const name = `v19-${Math.random()}`;
        const v19 = new Dexie(name);
        v19.version(19).stores({ events: "&id, kind", eventTags: "[tagValue+eventId], tagValue" });
        await v19.open();
        await v19.table("eventTags").put({ tagValue: "p:x", eventId: "a" });
        v19.close();

        createDatabase(name);
        await openDatabase();
        expect(db.verno).toBe(20);
        expect(await db.eventTags.where("eventId").equals("a").count()).toBe(1);
    });
});
