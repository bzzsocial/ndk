import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";
import { NDK } from "../ndk/index.js";
import { NDKEvent } from "./index.js";

const ROOT = "a".repeat(64);
const GRANDPARENT = "b".repeat(64);
const PARENT = "c".repeat(64);
const PK = "d".repeat(64);
const PK2 = "e".repeat(64);
const ARTICLE = `30023:${PK2}:my-article`;

const replyTo = (tags: string[][]) =>
    new NDKEvent(new NDK(), { id: PARENT, pubkey: PK, kind: 1, tags, content: "", created_at: 1 } as any).reply().tags;

describe("NDKEvent.reply() for kind 1 (NIP-10)", () => {
    it("makes a top-level note the root", () => {
        expect(replyTo([])).toEqual([
            ["e", PARENT, "", "root", PK],
            ["p", PK],
        ]);
    });

    it("replying to a reply of a reply targets that note, not its parent", () => {
        const tags = replyTo([
            ["e", ROOT, "wss://r.example", "root", PK2],
            ["e", GRANDPARENT, "", "reply", PK2],
            ["e", "f".repeat(64), "", "mention"],
            ["p", PK2],
        ]);
        expect(tags).toEqual([
            ["e", ROOT, "wss://r.example", "root", PK2],
            ["e", PARENT, "", "reply", PK],
            ["p", PK2],
            ["p", PK],
        ]);
        expect(tags.filter((t) => t[3] === "reply")).toHaveLength(1);
    });

    it("normalizes a root marker written into the relay slot", () => {
        expect(
            replyTo([
                ["e", ROOT, "root", PK2],
                ["e", GRANDPARENT, "reply"],
            ]).slice(0, 2),
        ).toEqual([
            ["e", ROOT, "", "root", PK2],
            ["e", PARENT, "", "reply", PK],
        ]);
    });

    it("uses the first unmarked e-tag as root for a legacy positional parent", () => {
        expect(
            replyTo([
                ["e", ROOT],
                ["e", GRANDPARENT],
            ]).slice(0, 2),
        ).toEqual([
            ["e", ROOT, "", "root"],
            ["e", PARENT, "", "reply", PK],
        ]);
    });

    it("treats a parent with only mention e-tags as the root", () => {
        expect(replyTo([["e", ROOT, "", "mention"]])[0]).toEqual(["e", PARENT, "", "root", PK]);
    });

    it("keeps an article comment thread rooted on the article (e + a)", () => {
        expect(
            replyTo([
                ["e", ROOT, "", "root"],
                ["a", ARTICLE, "", "root"],
                ["p", PK2],
                ["e", GRANDPARENT, "", "reply", PK2],
            ]),
        ).toEqual([
            ["e", ROOT, "", "root"],
            ["e", PARENT, "", "reply", PK],
            ["a", ARTICLE, "", "root"],
            ["p", PK2],
            ["p", PK],
        ]);
    });

    it("dedupes p tags and carries h (group) tags", () => {
        const tags = replyTo([
            ["e", ROOT, "", "root"],
            ["p", PK],
            ["p", PK],
            ["h", "grp"],
        ]);
        expect(tags.filter((t) => t[0] === "p")).toEqual([["p", PK]]);
        expect(tags.at(-1)).toEqual(["h", "grp"]);
    });

    it("writes p tags as hex: decodes npubs, drops junk, dedupes after decoding", () => {
        const tags = replyTo([
            ["p", nip19.npubEncode(PK2), "wss://r.example"],
            ["p", PK2],
            ["p", "not-a-pubkey"],
            ["p", PK.toUpperCase()],
        ]);
        expect(tags.filter((t) => t[0] === "p")).toEqual([
            ["p", PK2, "wss://r.example"],
            ["p", PK],
        ]);
    });
});
