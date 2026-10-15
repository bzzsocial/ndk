import { describe, expect, it, vi } from "vitest";
import { NDKEvent } from "../events/index.js";
import { NDK } from "../ndk/index.js";
import { NDKRelay, NDKRelayStatus } from "../relay/index.js";
import { NDKRelaySet } from "../relay/sets/index.js";
import { NDKPrivateKeySigner } from "../signers/private-key/index.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** Verification the test settles by hand, per event id. */
function manualVerifier() {
    const pending = new Map<string, (ok: boolean) => void>();
    const fn = (event: NDKEvent) => new Promise<boolean>((resolve) => pending.set(event.id, resolve));
    return { fn, settle: (id: string, ok: boolean) => pending.get(id)?.(ok), pending };
}

async function setup(verifyBeforeEmit = true) {
    const verifier = manualVerifier();
    const ndk = new NDK({ signatureVerificationFunction: verifier.fn, verifyBeforeEmit });
    const setEvent = vi.fn();
    ndk.cacheAdapter = { locking: false, query: () => [], setEvent } as any;
    const relay = new NDKRelay(`wss://r${Math.random().toString(36).slice(2, 6)}.example/`, undefined, ndk);
    relay.validationRatioFn = () => 1;
    ndk.pool.addRelay(relay, false);
    const raw: string[] = [];
    const conn = relay.connectivity as any;
    conn.ws = { readyState: WebSocket.OPEN, send: (s: string) => raw.push(s), close: () => {} };
    conn._status = NDKRelayStatus.CONNECTED;
    const recv = (msg: unknown[]) => conn.onMessage({ data: JSON.stringify(msg) });
    const sub = ndk.subscribe(
        { kinds: [1] },
        { relaySet: new NDKRelaySet(new Set([relay]), ndk), groupable: false, cacheUsage: "ONLY_RELAY" },
    );
    await tick();
    const subId = JSON.parse(raw[0])[1] as string;
    const order: string[] = [];
    sub.on("event", (e) => order.push(`event:${e.id}`));
    sub.on("eose", () => order.push("eose"));
    const signed = async (content: string) => {
        const e = new NDKEvent(ndk, { kind: 1, content } as any);
        await e.sign(NDKPrivateKeySigner.generate());
        return e.rawEvent();
    };
    return { ndk, sub, recv, subId, order, verifier, setEvent, signed, relay };
}

describe("verifyBeforeEmit", () => {
    it("emits and caches an event only once it is verified", async () => {
        const s = await setup();
        const ev = await s.signed("hi");
        s.recv(["EVENT", s.subId, ev]);
        await tick();
        expect(s.order).toEqual([]);
        expect(s.setEvent).not.toHaveBeenCalled();

        s.verifier.settle(ev.id!, true);
        await tick();
        expect(s.order).toEqual([`event:${ev.id}`]);
        expect(s.setEvent).toHaveBeenCalledTimes(1);
    });

    it("never delivers a forged event, and reports it", async () => {
        const s = await setup();
        const invalid = vi.fn();
        s.ndk.on("event:invalid-sig", invalid);
        const ev = await s.signed("forged");
        s.recv(["EVENT", s.subId, ev]);
        s.verifier.settle(ev.id!, false);
        await tick();
        expect(s.order).toEqual([]);
        expect(s.setEvent).not.toHaveBeenCalled();
        expect(invalid).toHaveBeenCalled();
    });

    it("emits eose after the events that arrived before it", async () => {
        const s = await setup();
        const ev = await s.signed("before eose");
        s.recv(["EVENT", s.subId, ev]);
        s.recv(["EOSE", s.subId]);
        await tick();
        expect(s.order).toEqual([]);

        s.verifier.settle(ev.id!, true);
        await tick();
        expect(s.order).toEqual([`event:${ev.id}`, "eose"]);
    });

    it("leaves the default (emit, then verify) unchanged when off", async () => {
        const s = await setup(false);
        const ev = await s.signed("hi");
        s.recv(["EVENT", s.subId, ev]);
        await tick();
        expect(s.order).toEqual([`event:${ev.id}`]);
    });
});
