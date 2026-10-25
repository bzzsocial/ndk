import createDebug from "debug";
import { NDKEvent } from "../events/index.js";
import { NDKKind } from "../events/kinds/index.js";
import type { NDK } from "../ndk/index.js";
import type { NDKSigner } from "../signers/index.js";
import type { NDKRelay } from ".";
import type { NDKPool } from "./pool/index.js";

/**
 * Why a policy is being asked to authenticate.
 *
 * - `challenge`: the relay sent an AUTH challenge and nothing is waiting on it. Many relays send
 *   one on every connection as an offer; declining it is quiet and leaves the connection as is.
 * - `auth-required`: the relay refused a publish or a REQ with `auth-required:` — answering is
 *   the only way that publish or REQ gets through.
 * - `manual`: the application called `relay.authenticate()`.
 */
type NDKAuthReason = "challenge" | "auth-required" | "manual";

/**
 * NDKAuthPolicies are functions that are called when a relay requests authentication
 * so that you can define a behavior for your application.
 *
 * @param relay The relay that requested authentication.
 * @param challenge The challenge that the relay sent.
 * @param reason Why authentication is being asked for. See NDKAuthReason.
 */
type NDKAuthPolicy = (
    relay: NDKRelay,
    challenge: string,
    reason?: NDKAuthReason,
) => Promise<boolean | undefined | NDKEvent>;

/**
 * This policy will disconnect from relays that request authentication.
 */
function disconnect(pool: NDKPool, debug?: debug.Debugger) {
    debug ??= createDebug("ndk:relay:auth-policies:disconnect");

    return async (relay: NDKRelay) => {
        debug?.(`Relay ${relay.url} requested authentication, disconnecting`);

        pool.removeRelay(relay.url);
    };
}

type ISignIn = {
    ndk?: NDK;
    signer?: NDKSigner;
    debug?: debug.Debugger;
};

async function signAndAuth(
    event: NDKEvent,
    relay: NDKRelay,
    signer: NDKSigner,
    debug: debug.Debugger,
    resolve: (event: NDKEvent) => void,
    reject: (event: NDKEvent) => void,
) {
    try {
        await event.sign(signer);
        resolve(event);
    } catch (e) {
        debug?.(`Failed to publish auth event to relay ${relay.url}`, e);
        reject(event);
    }
}

/**
 * Uses the signer to sign an event and then authenticate with the relay.
 * If no signer is provided the NDK signer will be used.
 * If none is not available it will wait for one to be ready.
 */
function signIn({ ndk, signer, debug }: ISignIn = {}) {
    debug ??= createDebug("ndk:auth-policies:signIn");

    return async (relay: NDKRelay, challenge: string): Promise<NDKEvent> => {
        debug?.(`Relay ${relay.url} requested authentication, signing in`);

        const event = new NDKEvent(ndk);
        event.kind = NDKKind.ClientAuth;
        event.tags = [
            ["relay", relay.url],
            ["challenge", challenge],
        ];

        signer ??= ndk?.signer;

        // If we dont have a signer, we need to wait for one to be ready
        // eslint-disable-next-line no-async-promise-executor
        return new Promise(async (resolve, reject) => {
            if (signer) {
                await signAndAuth(event, relay, signer, debug!, resolve, reject);
            } else {
                ndk?.once("signer:ready", async (signer) => {
                    await signAndAuth(event, relay, signer, debug!, resolve, reject);
                });
            }
        });
    };
}

const NDKRelayAuthPolicies = {
    disconnect,
    signIn,
};

export { NDKRelayAuthPolicies, type NDKAuthPolicy, type NDKAuthReason };
