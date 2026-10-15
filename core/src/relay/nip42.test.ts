import { afterEach, describe, expect, it, vi } from "vitest";
import { NDKEvent } from "../events/index.js";
import { NDK } from "../ndk/index.js";
import { NDKPrivateKeySigner } from "../signers/private-key/index.js";
import type { NDKAuthPolicy } from "./auth-policies.js";
import { NDKRelay, NDKRelayStatus } from "./index.js";
import { NDKRelaySet } from "./sets/index.js";

type Frame = unknown[];

/** An NDKRelay on a fake, already-open socket. `sent` holds every frame the client wrote. */
function connectedRelay(policy?: NDKAuthPolicy) {
    const ndk = new NDK({ signer: NDKPrivateKeySigner.generate() });
    const relay = new NDKRelay("wss://relay.example/", policy, ndk);
    const raw: string[] = [];
    const ws = { readyState: WebSocket.OPEN, send: (s: string) => raw.push(s), close: () => {} };
    const conn = relay.connectivity as any;
    conn.ws = ws;
    conn._status = NDKRelayStatus.CONNECTED;
    const recv = (msg: Frame) => conn.onMessage({ data: JSON.stringify(msg) });
    const frames = () =>
        raw.map((s) => {
            try {
                return JSON.parse(s) as Frame;
            } catch {
                return ["INVALID", s];
            }
        });
    const sent = (type: string) => frames().filter((f) => f[0] === type);
    const relaySet = new NDKRelaySet(new Set([relay]), ndk);
    const subscribe = async (closeOnEose = false) => {
        const s = ndk.subscribe({ kinds: [1] }, { relaySet, groupable: false, closeOnEose, cacheUsage: "ONLY_RELAY" });
        await tick();
        return s;
    };
    return { ndk, relay, recv, frames, sent, subscribe };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const signInPolicy: NDKAuthPolicy = async () => true;

/** Answers the AUTH frame the client sent with an OK. */
async function acceptAuth(r: ReturnType<typeof connectedRelay>, ok = true, reason = "") {
    await vi.waitFor(() => expect(r.sent("AUTH")).toHaveLength(1));
    const authEvent = r.sent("AUTH")[0][1] as { id: string };
    r.recv(["OK", authEvent.id, ok, reason]);
    await tick();
}

describe("NIP-42 authentication", () => {
    afterEach(() => vi.restoreAllMocks());

    it("emits authed once, after the relay accepts the AUTH event", async () => {
        const r = connectedRelay(signInPolicy);
        const authed = vi.fn();
        r.relay.on("authed", authed);

        r.recv(["AUTH", "challenge-1"]);
        await vi.waitFor(() => expect(r.sent("AUTH")).toHaveLength(1));
        expect(authed).not.toHaveBeenCalled();
        expect(r.relay.status).toBe(NDKRelayStatus.AUTHENTICATING);

        await acceptAuth(r);
        expect(authed).toHaveBeenCalledTimes(1);
        expect(r.relay.status).toBe(NDKRelayStatus.AUTHENTICATED);
    });

    it("signs the challenge it was given, for this relay", async () => {
        const r = connectedRelay(signInPolicy);
        r.recv(["AUTH", "challenge-1"]);
        await vi.waitFor(() => expect(r.sent("AUTH")).toHaveLength(1));
        const ev = r.sent("AUTH")[0][1] as { kind: number; tags: string[][] };
        expect(ev.kind).toBe(22242);
        expect(ev.tags).toContainEqual(["challenge", "challenge-1"]);
        expect(ev.tags).toContainEqual(["relay", "wss://relay.example/"]);
    });

    it("emits auth:failed and stays unauthenticated when the relay rejects AUTH", async () => {
        const r = connectedRelay(signInPolicy);
        const authed = vi.fn();
        const failed = vi.fn();
        r.relay.on("authed", authed);
        r.relay.on("auth:failed", failed);

        r.recv(["AUTH", "challenge-1"]);
        await acceptAuth(r, false, "restricted: not a member");

        expect(authed).not.toHaveBeenCalled();
        expect(failed).toHaveBeenCalledTimes(1);
        expect(r.relay.status).toBe(NDKRelayStatus.CONNECTED);
    });

    it("emits auth:failed when the policy throws", async () => {
        const r = connectedRelay(async () => {
            throw new Error("nope");
        });
        const failed = vi.fn();
        r.relay.on("auth:failed", failed);
        r.recv(["AUTH", "challenge-1"]);
        await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
        expect(r.relay.status).toBe(NDKRelayStatus.CONNECTED);
    });

    it("emits auth with the challenge when no policy is set", async () => {
        const r = connectedRelay();
        const onAuth = vi.fn();
        r.relay.on("auth", onAuth);
        r.recv(["AUTH", "challenge-1"]);
        expect(onAuth.mock.calls[0][0]).toBe("challenge-1");
        expect(r.relay.authChallenge).toBe("challenge-1");
        expect(r.sent("AUTH")).toHaveLength(0);
    });

    describe("relay.authenticate()", () => {
        it("answers the stored challenge and resolves once the relay accepts", async () => {
            const r = connectedRelay();
            r.recv(["AUTH", "challenge-1"]);
            r.relay.authPolicy = signInPolicy;

            const p = r.relay.authenticate();
            expect(r.relay.authenticate()).toBe(p); // shared while in flight
            await acceptAuth(r);
            await expect(p).resolves.toBe(true);
            await expect(r.relay.authenticate()).resolves.toBe(true);
            expect(r.sent("AUTH")).toHaveLength(1);
        });

        it("resolves false with no challenge, and when the policy declines", async () => {
            const r = connectedRelay(signInPolicy);
            await expect(r.relay.authenticate()).resolves.toBe(false);

            const declined = connectedRelay();
            declined.recv(["AUTH", "challenge-1"]);
            declined.relay.authPolicy = async () => false;
            await expect(declined.relay.authenticate()).resolves.toBe(false);
            expect(declined.sent("AUTH")).toHaveLength(0);
        });

        it("accepts a policy that returns a signed event", async () => {
            const r = connectedRelay();
            r.recv(["AUTH", "challenge-1"]);
            r.relay.authPolicy = async (relay, challenge) => {
                const ev = new NDKEvent(r.ndk, {
                    kind: 22242,
                    tags: [
                        ["relay", relay.url],
                        ["challenge", challenge],
                    ],
                } as any);
                await ev.sign();
                return ev;
            };
            const p = r.relay.authenticate();
            await acceptAuth(r);
            await expect(p).resolves.toBe(true);
            expect(r.relay.status).toBe(NDKRelayStatus.AUTHENTICATED);
        });
    });
});

describe("REQ handling around NIP-42", () => {
    it("never sends a malformed or empty REQ", async () => {
        const r = connectedRelay();
        r.relay.req({ subId: "empty", executeFilters: [], onclose() {} } as any);
        r.relay.req({ subId: "ok", executeFilters: [{ kinds: [1] }], onclose() {} } as any);
        r.relay.close("ok");
        expect(r.frames()).toEqual([
            ["REQ", "ok", { kinds: [1] }],
            ["CLOSE", "ok"],
        ]);
    });

    it("does not re-send a subscription that stopped before AUTH completed", async () => {
        const r = connectedRelay(signInPolicy);
        const sub = await r.subscribe();
        expect(r.sent("REQ")).toHaveLength(1);
        sub.stop();

        r.recv(["AUTH", "challenge-1"]);
        await acceptAuth(r);

        expect(r.sent("REQ")).toHaveLength(1);
        expect(r.sent("INVALID")).toHaveLength(0);
    });

    it("re-sends a subscription that was sent before AUTH exactly once", async () => {
        const r = connectedRelay(signInPolicy);
        await r.subscribe();
        r.recv(["AUTH", "challenge-1"]);
        await acceptAuth(r);
        expect(r.sent("REQ")).toHaveLength(2);

        // a later challenge on the same connection does not replay everything again
        r.recv(["AUTH", "challenge-2"]);
        await tick();
        await r.subscribe();
        expect(r.sent("REQ")).toHaveLength(3);
        expect(r.sent("INVALID")).toHaveLength(0);
    });

    it("answers CLOSED auth-required and re-sends that REQ once", async () => {
        const r = connectedRelay();
        r.recv(["AUTH", "challenge-1"]); // no policy yet: challenge stored only
        r.relay.authPolicy = signInPolicy;
        const sub = await r.subscribe();
        const closed = vi.fn();
        sub.on("closed", closed);
        const subId = r.sent("REQ")[0][1] as string;

        r.recv(["CLOSED", subId, "auth-required: members only"]);
        await acceptAuth(r);

        const reqs = r.sent("REQ");
        expect(reqs).toHaveLength(2);
        expect(reqs[1][2]).toEqual({ kinds: [1] });
        expect(closed).not.toHaveBeenCalled();

        // a second refusal is final
        r.recv(["CLOSED", reqs[1][1], "auth-required: still no"]);
        await tick();
        expect(r.sent("REQ")).toHaveLength(2);
        expect(closed).toHaveBeenCalledTimes(1);
    });

    it("treats CLOSED restricted: as final and as that relay finishing", async () => {
        const r = connectedRelay(signInPolicy);
        const sub = await r.subscribe(true);
        const closed = vi.fn();
        const eose = vi.fn();
        sub.on("closed", closed);
        sub.on("eose", eose);
        const subId = r.sent("REQ")[0][1] as string;

        r.recv(["CLOSED", subId, "restricted: not a member"]);
        await tick();

        expect(closed.mock.calls[0].slice(0, 2)).toEqual([r.relay, "restricted: not a member"]);
        expect(eose).toHaveBeenCalledTimes(1);
        expect(r.sent("REQ")).toHaveLength(1);
        expect(r.sent("AUTH")).toHaveLength(0);
    });

    it("stops waiting on auth-required when there is no way to authenticate", async () => {
        const r = connectedRelay();
        const sub = await r.subscribe(true);
        const closed = vi.fn();
        sub.on("closed", closed);
        const subId = r.sent("REQ")[0][1] as string;
        r.recv(["CLOSED", subId, "auth-required: members only"]);
        await tick();
        expect(closed).toHaveBeenCalledTimes(1);
        expect(r.sent("REQ")).toHaveLength(1);
    });
});

describe("connection state", () => {
    it("reconnects after an authenticated connection drops, and forgets the challenge", async () => {
        const r = connectedRelay(signInPolicy);
        r.recv(["AUTH", "challenge-1"]);
        await acceptAuth(r);
        const conn = r.relay.connectivity as any;
        const reconnect = vi.spyOn(conn, "handleReconnection").mockImplementation(() => {});

        conn.onDisconnect();

        expect(reconnect).toHaveBeenCalled();
        expect(r.relay.authChallenge).toBeUndefined();
    });
});
