import { describe, expect, it, vi } from "vitest";
import { NDKEvent } from "../events/index.js";
import { NDK } from "../ndk/index.js";
import { NDKPrivateKeySigner } from "../signers/private-key/index.js";
import type { NDKAuthPolicy, NDKAuthReason } from "./auth-policies.js";
import { NDKRelay, NDKRelayStatus } from "./index.js";

/**
 * A challenge is an offer until something needs it. Many relays send AUTH on every connect; a
 * client that answers each one hands its pubkey to every relay that asks, and one that *declines*
 * used to reject every publish in flight on that relay as an auth failure.
 */

type Frame = unknown[];

function connectedRelay(policy?: NDKAuthPolicy) {
    const ndk = new NDK({ signer: NDKPrivateKeySigner.generate() });
    const relay = new NDKRelay("wss://relay.example/", policy, ndk);
    const raw: string[] = [];
    const ws = { readyState: WebSocket.OPEN, send: (s: string) => raw.push(s), close: () => {} };
    const conn = relay.connectivity as any;
    conn.ws = ws;
    conn._status = NDKRelayStatus.CONNECTED;
    const recv = (msg: Frame) => conn.onMessage({ data: JSON.stringify(msg) });
    const sent = (type: string) => raw.map((s) => JSON.parse(s) as Frame).filter((f) => f[0] === type);
    return { ndk, relay, recv, sent };
}

async function signedNote(ndk: NDK, content: string) {
    const event = new NDKEvent(ndk);
    event.kind = 1;
    event.content = content;
    await event.sign();
    return event;
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** Signs only when something needs it; records every reason it was asked with. */
function onDemandPolicy() {
    const reasons: (NDKAuthReason | undefined)[] = [];
    const policy: NDKAuthPolicy = async (_relay, _challenge, reason) => {
        reasons.push(reason);
        return reason !== "challenge";
    };
    return { policy, reasons };
}

async function acceptAuth(r: ReturnType<typeof connectedRelay>) {
    await vi.waitFor(() => expect(r.sent("AUTH")).toHaveLength(1));
    const authEvent = r.sent("AUTH")[0][1] as { id: string };
    r.recv(["OK", authEvent.id, true, ""]);
    await tick();
}

describe("AUTH on demand", () => {
    it("tells the policy an unprompted challenge is an offer, and declining it is quiet", async () => {
        const { policy, reasons } = onDemandPolicy();
        const r = connectedRelay(policy);
        const failed = vi.fn();
        r.relay.on("auth:failed", failed);

        r.recv(["AUTH", "c1"]);
        await tick();

        expect(reasons).toEqual(["challenge"]);
        expect(r.sent("AUTH")).toHaveLength(0);
        expect(failed).not.toHaveBeenCalled();
        expect(r.relay.status).toBe(NDKRelayStatus.CONNECTED);
        expect(r.relay.authChallenge).toBe("c1");
    });

    it("does not reject a publish in flight when an offer is declined", async () => {
        const { policy } = onDemandPolicy();
        const r = connectedRelay(policy);
        const event = await signedNote(r.ndk, "in flight");
        const publish = r.relay.publish(event);

        r.recv(["AUTH", "c1"]);
        await tick();
        r.recv(["OK", event.id, true, ""]);

        await expect(publish).resolves.toBe(true);
    });

    it("answers the stored challenge when a publish is refused with auth-required", async () => {
        const { policy, reasons } = onDemandPolicy();
        const r = connectedRelay(policy);
        r.recv(["AUTH", "c1"]);
        await tick();

        const event = await signedNote(r.ndk, "members only");
        const publish = r.relay.publish(event);
        r.recv(["OK", event.id, false, "auth-required: members only"]);
        await acceptAuth(r);

        expect(reasons).toEqual(["challenge", "auth-required"]);
        expect(r.sent("EVENT")).toHaveLength(2);
        r.recv(["OK", event.id, true, ""]);
        await expect(publish).resolves.toBe(true);
    });

    it("answers a challenge that arrives after the refusal as a need", async () => {
        const { policy, reasons } = onDemandPolicy();
        const r = connectedRelay(policy);
        const event = await signedNote(r.ndk, "before the challenge");
        const publish = r.relay.publish(event);

        r.recv(["OK", event.id, false, "auth-required:"]);
        r.recv(["AUTH", "c1"]);
        await acceptAuth(r);

        expect(reasons).toEqual(["auth-required"]);
        r.recv(["OK", event.id, true, ""]);
        await expect(publish).resolves.toBe(true);
    });

    it("answers a manual authenticate() made before the challenge, once it arrives", async () => {
        const { policy, reasons } = onDemandPolicy();
        const r = connectedRelay(policy);

        await expect(r.relay.authenticate()).resolves.toBe(false);
        r.recv(["AUTH", "c1"]);
        await acceptAuth(r);

        expect(reasons).toEqual(["manual"]);
        expect(r.relay.status).toBe(NDKRelayStatus.AUTHENTICATED);
    });

    it("gives a publish waiting on AUTH a fresh timeout", async () => {
        const { policy } = onDemandPolicy();
        const r = connectedRelay(policy);
        r.recv(["AUTH", "c1"]);
        await tick();

        const event = await signedNote(r.ndk, "slow auth");
        const publish = r.relay.publish(event, 40);
        r.recv(["OK", event.id, false, "auth-required:"]);
        // Past the original 40ms before AUTH is accepted.
        await tick(80);
        await acceptAuth(r);
        r.recv(["OK", event.id, true, ""]);

        await expect(publish).resolves.toBe(true);
    });

    it("re-sends after AUTH only what the relay refused", async () => {
        const { policy } = onDemandPolicy();
        const r = connectedRelay(policy);
        r.recv(["AUTH", "c1"]);
        await tick();

        const refused = await signedNote(r.ndk, "refused");
        const waiting = await signedNote(r.ndk, "still waiting");
        const p1 = r.relay.publish(refused);
        const p2 = r.relay.publish(waiting);
        r.recv(["OK", refused.id, false, "auth-required:"]);
        await acceptAuth(r);

        const resent = r.sent("EVENT").map((f) => (f[1] as { id: string }).id);
        expect(resent).toEqual([refused.id, waiting.id, refused.id]);
        r.recv(["OK", refused.id, true, ""]);
        r.recv(["OK", waiting.id, true, ""]);
        await expect(Promise.all([p1, p2])).resolves.toEqual([true, true]);
    });

    it("rejects at once an auth-required on a connection already authenticated", async () => {
        const { policy } = onDemandPolicy();
        const r = connectedRelay(policy);
        r.recv(["AUTH", "c1"]);
        await tick();
        const authed = r.relay.authenticate();
        await acceptAuth(r);
        await expect(authed).resolves.toBe(true);

        const event = await signedNote(r.ndk, "not a member");
        const publish = r.relay.publish(event);
        r.recv(["OK", event.id, false, "auth-required: not a member"]);

        await expect(publish).rejects.toThrow("auth-required: not a member");
    });

    it("gives up waiting for a signer that never comes", async () => {
        const ndk = new NDK({});
        const relay = new NDKRelay("wss://relay.example/", async () => true, ndk);
        const conn = relay.connectivity as any;
        conn.ws = { readyState: WebSocket.OPEN, send: () => {}, close: () => {} };
        conn._status = NDKRelayStatus.CONNECTED;
        conn.authTimeoutMs = 20;
        const failed = vi.fn();
        relay.on("auth:failed", failed);

        conn.onMessage({ data: JSON.stringify(["AUTH", "c1"]) });
        await vi.waitFor(() => expect(failed).toHaveBeenCalled());
        expect(relay.status).toBe(NDKRelayStatus.CONNECTED);
    });

    it("settles every attempt, a quietly declined offer included", async () => {
        const { policy } = onDemandPolicy();
        const r = connectedRelay(policy);
        const settled = vi.fn();
        r.relay.on("auth:settled", settled);

        r.recv(["AUTH", "c1"]);
        await tick();
        expect(settled.mock.lastCall?.[0]).toBe(false);

        const authed = r.relay.authenticate("manual");
        await acceptAuth(r);
        await expect(authed).resolves.toBe(true);
        expect(settled.mock.lastCall?.[0]).toBe(true);
        expect(settled).toHaveBeenCalledTimes(2);
    });

    it("records whom the connection signed in as, until it closes", async () => {
        const r = connectedRelay(async () => true);
        r.recv(["AUTH", "c1"]);
        await acceptAuth(r);
        expect(r.relay.authedAs).toBe((await r.ndk.signer!.user()).pubkey);

        (r.relay.connectivity as any).onDisconnect();
        expect(r.relay.authedAs).toBeUndefined();
    });
});
