import { describe, expect, it, vi } from "vitest";
import { NDK } from "../ndk/index.js";
import { NDKRelay, NDKRelayStatus } from "../relay/index.js";
import { NDKRelaySet } from "../relay/sets/index.js";

/** An NDKRelay in `ndk`'s pool on a fake, already-open socket. */
function openRelay(ndk: NDK, url: string) {
    const relay = new NDKRelay(url, undefined, ndk);
    ndk.pool.addRelay(relay, false);
    const raw: string[] = [];
    const conn = relay.connectivity as any;
    conn.ws = { readyState: WebSocket.OPEN, send: (s: string) => raw.push(s), close: () => {} };
    conn._status = NDKRelayStatus.CONNECTED;
    const recv = (msg: unknown[]) => conn.onMessage({ data: JSON.stringify(msg) });
    const reqIds = () => raw.map((s) => JSON.parse(s)).filter((f) => f[0] === "REQ").map((f) => f[1] as string);
    return { relay, recv, reqIds };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe("subscription EOSE", () => {
    it("emits eose when only one of two relays ever answers", async () => {
        const ndk = new NDK();
        const a = openRelay(ndk, "wss://a.example/");
        const b = openRelay(ndk, "wss://b.example/");
        const sub = ndk.subscribe(
            { kinds: [1] },
            { relaySet: new NDKRelaySet(new Set([a.relay, b.relay]), ndk), groupable: false, cacheUsage: "ONLY_RELAY" },
        );
        const eose = vi.fn();
        sub.on("eose", eose);
        await tick();

        a.recv(["EOSE", a.reqIds()[0]]);
        await vi.waitFor(() => expect(eose).toHaveBeenCalledTimes(1), { timeout: 1500 });
    });

    it("waits longer when fewer of the relays have answered", async () => {
        const ndk = new NDK();
        const relays = ["a", "b", "c", "d"].map((n) => openRelay(ndk, `wss://${n}.example/`));
        const sub = ndk.subscribe(
            { kinds: [1] },
            {
                relaySet: new NDKRelaySet(new Set(relays.map((r) => r.relay)), ndk),
                groupable: false,
                cacheUsage: "ONLY_RELAY",
            },
        );
        const eose = vi.fn();
        sub.on("eose", eose);
        await tick();

        relays[0].recv(["EOSE", relays[0].reqIds()[0]]);
        await tick(400);
        expect(eose).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(eose).toHaveBeenCalledTimes(1), { timeout: 1500 });
    });

    it("emits relay:eose for each relay that finishes", async () => {
        const ndk = new NDK();
        const a = openRelay(ndk, "wss://a.example/");
        const b = openRelay(ndk, "wss://b.example/");
        const sub = ndk.subscribe(
            { kinds: [1] },
            { relaySet: new NDKRelaySet(new Set([a.relay, b.relay]), ndk), groupable: false, cacheUsage: "ONLY_RELAY" },
        );
        const finished: string[] = [];
        sub.on("relay:eose", (relay) => finished.push(relay.url));
        await tick();

        a.recv(["EOSE", a.reqIds()[0]]);
        b.recv(["CLOSED", b.reqIds()[0], "restricted: no"]);
        expect(finished).toEqual(["wss://a.example/", "wss://b.example/"]);
    });

    it("doesn't hang when the cache query fails", async () => {
        const ndk = new NDK();
        ndk.cacheAdapter = { locking: true, query: () => Promise.reject(new Error("IndexedDB is gone")) } as any;
        const a = openRelay(ndk, "wss://a.example/");
        const sub = ndk.subscribe(
            { kinds: [1] },
            { relaySet: new NDKRelaySet(new Set([a.relay]), ndk), groupable: false, addSinceFromCache: true },
        );
        const eose = vi.fn();
        sub.on("eose", eose);
        await tick();

        expect(a.reqIds()).toHaveLength(1);
        a.recv(["EOSE", a.reqIds()[0]]);
        expect(eose).toHaveBeenCalledTimes(1);
    });
});
