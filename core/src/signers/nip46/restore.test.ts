import { afterEach, describe, expect, it, vi } from "vitest";
import { NDK } from "../../ndk/index.js";
import { NDKPrivateKeySigner } from "../private-key/index.js";
import { NDKNip46Signer, NDKNip46TimeoutError } from "./index.js";
import { NDKNostrRpc } from "./rpc.js";

const USER = "d".repeat(64);
const BUNKER = "e".repeat(64);

afterEach(() => vi.restoreAllMocks());

describe("NDKNip46Signer.restore", () => {
    it("restores an approved session without a connect request, and listens for responses", async () => {
        const subscribe = vi.spyOn(NDKNostrRpc.prototype, "subscribe").mockResolvedValue({} as any);
        const sendRequest = vi.spyOn(NDKNostrRpc.prototype, "sendRequest").mockResolvedValue({} as any);

        const signer = NDKNip46Signer.restore(new NDK(), {
            localSigner: NDKPrivateKeySigner.generate(),
            bunkerPubkey: BUNKER,
            userPubkey: USER,
            relayUrls: ["wss://bunker.example/"],
            secret: "s",
        });

        expect(signer.pubkey).toBe(USER);
        expect((await signer.user()).pubkey).toBe(USER);
        await vi.waitFor(() => expect(subscribe).toHaveBeenCalled());
        expect(sendRequest).not.toHaveBeenCalled();
    });

    it("applies the request timeout", async () => {
        vi.spyOn(NDKNostrRpc.prototype, "subscribe").mockResolvedValue({} as any);
        vi.spyOn(NDKNostrRpc.prototype, "sendRequest").mockResolvedValue({} as any); // never answers
        const signer = NDKNip46Signer.restore(new NDK(), {
            localSigner: NDKPrivateKeySigner.generate(),
            bunkerPubkey: BUNKER,
            userPubkey: USER,
            timeout: 20,
        });
        await expect(signer.sign({ kind: 1, content: "", tags: [], created_at: 1, pubkey: USER })).rejects.toBeInstanceOf(
            NDKNip46TimeoutError,
        );
    });
});
