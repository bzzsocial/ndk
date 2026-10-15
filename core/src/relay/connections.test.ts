import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NDK } from "../ndk/index.js";
import { NDKRelay, NDKRelayStatus } from "./index.js";
import { NDKRelaySet } from "./sets/index.js";

class FakeWS {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static all: FakeWS[] = [];

    readyState = FakeWS.CONNECTING;
    sent: string[] = [];
    onopen?: (e: unknown) => void;
    onclose?: (e: unknown) => void;
    onmessage?: (e: { data: string }) => void;
    onerror?: (e: unknown) => void;
    addEventListener() {}
    removeEventListener() {}

    constructor(public url: string) {
        FakeWS.all.push(this);
    }
    send(s: string) {
        this.sent.push(s);
    }
    close() {
        if (this.readyState === FakeWS.CLOSED) return;
        this.readyState = FakeWS.CLOSED;
        queueMicrotask(() => this.onclose?.({}));
    }
    open() {
        this.readyState = FakeWS.OPEN;
        this.onopen?.({});
    }
    recv(msg: unknown[]) {
        this.onmessage?.({ data: JSON.stringify(msg) });
    }
    frames(type?: string) {
        return this.sent.map((s) => JSON.parse(s) as unknown[]).filter((f) => !type || f[0] === type);
    }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const lastSocket = () => FakeWS.all[FakeWS.all.length - 1];

async function openRelay(ndk: NDK, url = "wss://relay.example/") {
    const relay = new NDKRelay(url, undefined, ndk);
    ndk.pool.addRelay(relay, false);
    void relay.connect();
    lastSocket().open();
    await tick();
    return relay;
}

beforeEach(() => {
    FakeWS.all = [];
    vi.stubGlobal("WebSocket", FakeWS);
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("relayConnectionFilter", () => {
    it("is enforced on connect, so a refused relay never opens a socket", async () => {
        const ndk = new NDK({ relayConnectionFilter: (url) => !url.includes(".onion") });
        const set = NDKRelaySet.fromRelayUrls(["wss://abc.onion", "wss://relay.example"], ndk, false);
        for (const relay of set.relays) await relay.connect().catch(() => {});
        expect(FakeWS.all.map((ws) => ws.url)).toEqual(["wss://relay.example/"]);
    });
});

describe("NDK options", () => {
    it("does not change the caller's explicitRelayUrls array", () => {
        const urls = ["wss://a.example/"];
        const ndk = new NDK({ explicitRelayUrls: urls });
        ndk.addExplicitRelay("wss://b.example/", undefined, false);
        expect(urls).toEqual(["wss://a.example/"]);
    });
});

describe("relay.ping()", () => {
    it("resolves true on a response to its own REQ, and closes it", async () => {
        const relay = await openRelay(new NDK());
        const ws = lastSocket();
        const ping = relay.ping(1000);
        const [, id] = ws.frames("REQ")[0];

        ws.recv(["EOSE", "someone-else"]);
        ws.recv(["NOTICE", "hello"]);
        let settled = false;
        void ping.then(() => (settled = true));
        await tick();
        expect(settled).toBe(false);

        ws.recv(["EOSE", id]);
        await expect(ping).resolves.toBe(true);
        expect(ws.frames("CLOSE")).toContainEqual(["CLOSE", id]);
    });

    it("counts a CLOSED as a response", async () => {
        const relay = await openRelay(new NDK());
        const ws = lastSocket();
        const ping = relay.ping(1000);
        ws.recv(["CLOSED", ws.frames("REQ")[0][1], "auth-required: hi"]);
        await expect(ping).resolves.toBe(true);
    });

    it("resolves false when the relay doesn't answer in time, and shares one probe", async () => {
        const relay = await openRelay(new NDK());
        const ping = relay.ping(20);
        expect(relay.ping(20)).toBe(ping);
        await expect(ping).resolves.toBe(false);
        expect(lastSocket().frames("REQ")).toHaveLength(1);
    });

    it("resolves false when not connected", async () => {
        const relay = new NDKRelay("wss://relay.example/", undefined, new NDK());
        await expect(relay.ping(20)).resolves.toBe(false);
    });
});

describe("relay.reconnect()", () => {
    it("replaces an open socket with a new one", async () => {
        const relay = await openRelay(new NDK());
        const first = lastSocket();
        const done = relay.reconnect();
        await tick();
        expect(first.readyState).toBe(FakeWS.CLOSED);
        expect(FakeWS.all).toHaveLength(2);
        lastSocket().open();
        await done;
        expect(relay.status).toBe(NDKRelayStatus.CONNECTED);
    });

    it("works while the old socket is still closing", async () => {
        const relay = await openRelay(new NDK());
        relay.disconnect();
        expect(relay.status).toBe(NDKRelayStatus.DISCONNECTING);
        const done = relay.reconnect();
        await tick();
        expect(FakeWS.all).toHaveLength(2);
        lastSocket().open();
        await done;
        expect(relay.connected).toBe(true);
    });
});

describe("disconnect()", () => {
    it("cancels a scheduled reconnect", async () => {
        const relay = await openRelay(new NDK());
        const conn = relay.connectivity as any;
        conn.reconnectTimeout = setTimeout(() => {}, 60_000);
        relay.disconnect();
        expect(conn.reconnectTimeout).toBeUndefined();
    });
});

describe("subscriptions across reconnects", () => {
    it("re-sends a running subscription on the new socket, and not a stopped one", async () => {
        const ndk = new NDK();
        const relay = await openRelay(ndk);
        const relaySet = new NDKRelaySet(new Set([relay]), ndk);
        const opts = { relaySet, groupable: false, closeOnEose: false, cacheUsage: "ONLY_RELAY" as const };
        const live = ndk.subscribe({ kinds: [1] }, opts);
        const stopped = ndk.subscribe({ kinds: [7] }, opts);
        await tick();
        const first = lastSocket();
        const [, liveId] = first.frames("REQ").find((f) => (f[2] as { kinds: number[] }).kinds[0] === 1)!;
        first.recv(["EOSE", liveId]);
        stopped.stop();

        const conn = relay.connectivity as any;
        vi.spyOn(conn, "handleReconnection").mockImplementation(() => {});
        first.close();
        await tick();
        void relay.connect();
        const second = lastSocket();
        second.open();
        await tick();

        const reqs = second.frames("REQ");
        expect(reqs).toHaveLength(1);
        expect(reqs[0][2]).toEqual({ kinds: [1] });
        const events: unknown[] = [];
        live.on("event", (e) => events.push(e));
        expect(live).toBeDefined();
    });
});

describe("pool monitor", () => {
    it("doesn't add pool relays to a subscription with an explicit relay set", async () => {
        const ndk = new NDK();
        const a = await openRelay(ndk, "wss://a.example/");
        const subscribe = vi.spyOn(NDKRelay.prototype, "subscribe");
        ndk.subscribe(
            { kinds: [1] },
            { relaySet: new NDKRelaySet(new Set([a]), ndk), groupable: false, cacheUsage: "ONLY_RELAY" },
        );
        await tick();
        await openRelay(ndk, "wss://b.example/");
        expect(subscribe.mock.contexts.map((relay) => (relay as NDKRelay).url)).toEqual(["wss://a.example/"]);
    });
});

describe("connection monitoring", () => {
    it("notices a dead socket on an authenticated connection", async () => {
        vi.useFakeTimers();
        const relay = new NDKRelay("wss://relay.example/", undefined, new NDK());
        const conn = relay.connectivity as any;
        conn.ws = { readyState: FakeWS.CLOSED, close() {} };
        conn._status = NDKRelayStatus.AUTHENTICATED;
        const stale = vi.spyOn(conn, "handleStaleConnection").mockImplementation(() => {});
        vi.advanceTimersByTime(5_100);
        expect(stale).toHaveBeenCalled();
    });

    it("restarts monitoring when a relay connects again after disconnect()", async () => {
        const relay = await openRelay(new NDK());
        const conn = relay.connectivity as any;
        relay.disconnect();
        expect(conn.wsStateMonitor).toBeUndefined();
        await tick();
        void relay.connect();
        lastSocket().open();
        expect(conn.wsStateMonitor).toBeDefined();
        relay.disconnect();
    });
});
