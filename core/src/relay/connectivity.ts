import type debug from "debug";
import type { NostrEvent } from "../events/index.js";
import { NDKEvent } from "../events/index.js";
import { NDKKind } from "../events/kinds";
import type { NDK, NDKNetDebug } from "../ndk/index.js";
import type { NDKFilter } from "../subscription";
import type { NDKRelay, NDKRelayConnectionStats } from ".";
import { NDKRelayStatus } from ".";
import { NDKRelayKeepalive } from "./keepalive";
import type { NDKRelaySubscription } from "./subscription";
import type { NDKAuthReason } from "./auth-policies.js";

// Removed MAX_RECONNECT_ATTEMPTS - we retry indefinitely with capped backoff
const FLAPPING_THRESHOLD_MS = 1000;

import type { NDKCountResult } from "../count/index.js";
import { NDKCountHll } from "../count/index.js";

export type CountResolver = {
    resolve: (result: NDKCountResult) => void;
    reject: (err: Error) => void;
};

export type EventPublishResolver = {
    resolve: (reason: string) => void;
    reject: (err: Error) => void;
};

export class NDKRelayConnectivity {
    private ndkRelay: NDKRelay;
    private ws?: WebSocket;
    private _status: NDKRelayStatus;
    private timeoutMs?: number;
    private connectedAt?: number;
    private _connectionStats: NDKRelayConnectionStats = {
        attempts: 0,
        success: 0,
        durations: [],
    };
    private debug: debug.Debugger;
    public netDebug?: NDKNetDebug;
    private connectTimeout: ReturnType<typeof setTimeout> | undefined;
    private reconnectTimeout: ReturnType<typeof setTimeout> | undefined;
    private ndk?: NDK;
    public openSubs: Map<string, NDKRelaySubscription> = new Map();
    private openCountRequests = new Map<string, CountResolver>();
    private openEventPublishes = new Map<string, EventPublishResolver[]>();
    private pendingAuthPublishes = new Map<string, NostrEvent>();
    /** Publishes the relay refused with auth-required, held until this connection authenticates.
     * Only these are re-sent after AUTH, or rejected when it fails — not every publish in flight. */
    private authBlocked = new Set<string>();
    /** Called when a publish starts waiting on AUTH, so its caller can extend its own timeout. */
    private authWaitHooks = new Map<string, () => void>();
    /** Something asked to authenticate before the relay sent a challenge, and why. */
    private authWanted?: NDKAuthReason;
    private serial = 0;
    public baseEoseTimeout = 4_400;

    /** The latest NIP-42 challenge on the current connection. */
    public authChallenge?: string;
    /** The pubkey this connection is signed in as (NIP-42), until the connection closes. */
    public authedAs?: string;
    private authInFlight?: Promise<boolean>;
    /** How long to wait for the relay's OK on an AUTH event, and for a signer to sign it. */
    public authTimeoutMs = 10_000;

    /** Silence after which the keepalive pings the relay. */
    public keepaliveIdleMs = 120_000;
    private pings = new Map<string, (answered: boolean) => void>();
    private pingInFlight?: Promise<boolean>;
    /** Subscriptions running when the last connection dropped; re-sent on the next one. */
    private retiredSubs = new Set<NDKRelaySubscription>();

    // Keepalive and monitoring
    private keepalive?: NDKRelayKeepalive;
    private wsStateMonitor?: ReturnType<typeof setInterval>;
    private sleepDetector?: ReturnType<typeof setInterval>;
    private lastSleepCheck = Date.now();
    private lastMessageSent = Date.now();
    private wasIdle = false;

    constructor(ndkRelay: NDKRelay, ndk?: NDK) {
        this.ndkRelay = ndkRelay;
        this._status = NDKRelayStatus.DISCONNECTED;
        const rand = Math.floor(Math.random() * 1000);
        this.debug = this.ndkRelay.debug.extend(`connectivity${rand}`);
        this.ndk = ndk;
        this.setupMonitoring();
    }

    /**
     * Sets up keepalive, WebSocket state monitoring, and sleep detection
     */
    private setupMonitoring(): void {
        // Setup keepalive to detect silent relays
        this.keepalive = new NDKRelayKeepalive(this.keepaliveIdleMs, async () => {
            this.debug("Relay silence detected, probing connection");
            const isAlive = await this.ping(5_000);

            if (!isAlive) {
                this.debug("Probe failed, connection is stale");
                this.handleStaleConnection();
            }
        });

        // Monitor WebSocket readyState every 5 seconds
        this.wsStateMonitor = setInterval(() => {
            if (this._status >= NDKRelayStatus.CONNECTED) {
                if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                    this.debug("WebSocket died silently, reconnecting");
                    this.handleStaleConnection();
                }
            }
        }, 5000);

        // Detect system sleep by monitoring time gaps
        this.sleepDetector = setInterval(() => {
            const now = Date.now();
            const elapsed = now - this.lastSleepCheck;

            // If more than 15 seconds elapsed (should be 10), system was likely suspended
            if (elapsed > 15000) {
                this.debug(`Detected possible sleep/wake (${elapsed}ms gap)`);
                this.handlePossibleWake();
            }

            this.lastSleepCheck = now;
        }, 10000);
    }

    /**
     * Handles detection of a stale connection by cleaning up and triggering reconnection.
     */
    private handleStaleConnection(): void {
        this.wasIdle = true; // Mark as idle to reset backoff

        // Stop keepalive
        this.keepalive?.stop();

        // Clean up the dead WebSocket; its late close event must not touch the next one
        this.dropSocket();
        this.retireConnection();

        this._status = NDKRelayStatus.DISCONNECTED;
        this.ndkRelay.emit("disconnect");

        // Trigger reconnection for stale connections
        this.handleReconnection();
    }

    /**
     * Handles possible system wake event
     */
    private handlePossibleWake(): void {
        this.debug("System wake detected, checking all connections");
        this.wasIdle = true; // Reset backoff for wake scenario

        // If we think we're connected but might not be, force reconnect
        if (this._status >= NDKRelayStatus.CONNECTED) {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                this.handleStaleConnection();
            } else {
                // Connection seems OK, but probe to be sure
                this.ping(5_000).then((isAlive) => {
                    if (!isAlive) {
                        this.handleStaleConnection();
                    }
                });
            }
        }
    }

    /**
     * Resets the reconnection state for system-wide events
     * Used by NDKPool when detecting system sleep/wake
     */
    public resetReconnectionState(): void {
        this.wasIdle = true;
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }
    }

    /**
     * Connects to the NDK relay and handles the connection lifecycle.
     *
     * This method attempts to establish a WebSocket connection to the NDK relay specified in the `ndkRelay` object.
     * If the connection is successful, it updates the connection statistics, sets the connection status to `CONNECTED`,
     * and emits `connect` and `ready` events on the `ndkRelay` object.
     *
     * If the connection attempt fails, it handles the error by either initiating a reconnection attempt or emitting a
     * `delayed-connect` event on the `ndkRelay` object, depending on the `reconnect` parameter.
     *
     * @param timeoutMs - The timeout in milliseconds for the connection attempt. If not provided, the default timeout from the `ndkRelay` object is used.
     * @param reconnect - Indicates whether a reconnection should be attempted if the connection fails. Defaults to `true`.
     * @returns A Promise that resolves when the connection is established, or rejects if the connection fails.
     */
    async connect(timeoutMs?: number, reconnect = true): Promise<void> {
        const filter = this.ndk?.relayConnectionFilter;
        if (filter && !filter(this.ndkRelay.url)) {
            this.debug("Not connecting: refused by relayConnectionFilter");
            return;
        }

        // Check if WebSocket exists but is not open (stale connection)
        if (this.ws && this.ws.readyState !== WebSocket.OPEN && this.ws.readyState !== WebSocket.CONNECTING) {
            this.debug("Cleaning up stale WebSocket connection");
            try {
                this.ws.close();
            } catch (e) {
                // Ignore errors when closing stale connection
            }
            this.ws = undefined;
            this._status = NDKRelayStatus.DISCONNECTED;
        }

        if (
            (this._status !== NDKRelayStatus.RECONNECTING && this._status !== NDKRelayStatus.DISCONNECTED) ||
            this.reconnectTimeout
        ) {
            this.debug(
                "Relay requested to be connected but was in state %s or it had a reconnect timeout",
                this._status,
            );
            return;
        }

        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }

        if (this.connectTimeout) {
            clearTimeout(this.connectTimeout);
            this.connectTimeout = undefined;
        }

        timeoutMs ??= this.timeoutMs;
        if (!this.timeoutMs && timeoutMs) this.timeoutMs = timeoutMs;

        if (this.timeoutMs) this.connectTimeout = setTimeout(() => this.onConnectionError(reconnect), this.timeoutMs);

        try {
            this.updateConnectionStats.attempt();
            if (this._status === NDKRelayStatus.DISCONNECTED) this._status = NDKRelayStatus.CONNECTING;
            else this._status = NDKRelayStatus.RECONNECTING;

            this.ws = new WebSocket(this.ndkRelay.url);
            this.ws.onopen = this.onConnect.bind(this);
            this.ws.onclose = this.onDisconnect.bind(this);
            this.ws.onmessage = this.onMessage.bind(this);
            this.ws.onerror = this.onError.bind(this);
        } catch (e) {
            this.debug(`Failed to connect to ${this.ndkRelay.url}`, e);
            this._status = NDKRelayStatus.DISCONNECTED;
            if (reconnect) this.handleReconnection();
            else this.ndkRelay.emit("delayed-connect", 2 * 24 * 60 * 60 * 1000);
            throw e;
        }
    }

    /**
     * Disconnects the WebSocket connection to the NDK relay.
     * This method sets the connection status to `NDKRelayStatus.DISCONNECTING`,
     * attempts to close the WebSocket connection, and sets the status to
     * `NDKRelayStatus.DISCONNECTED` if the disconnect operation fails.
     */
    public disconnect(): void {
        this._status = NDKRelayStatus.DISCONNECTING;

        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }
        if (this.connectTimeout) {
            clearTimeout(this.connectTimeout);
            this.connectTimeout = undefined;
        }

        // Clean up monitoring
        this.keepalive?.stop();
        if (this.wsStateMonitor) {
            clearInterval(this.wsStateMonitor);
            this.wsStateMonitor = undefined;
        }
        if (this.sleepDetector) {
            clearInterval(this.sleepDetector);
            this.sleepDetector = undefined;
        }

        try {
            this.ws?.close();
        } catch (e) {
            this.debug("Failed to disconnect", e);
            this._status = NDKRelayStatus.DISCONNECTED;
        }
    }

    /**
     * Handles the error that occurred when attempting to connect to the NDK relay.
     * If `reconnect` is `true`, this method will initiate a reconnection attempt.
     * Otherwise, it will emit a `delayed-connect` event on the `ndkRelay` object,
     * indicating that a reconnection should be attempted after a delay.
     *
     * @param reconnect - Indicates whether a reconnection should be attempted.
     */
    onConnectionError(reconnect: boolean): void {
        this.debug(`Error connecting to ${this.ndkRelay.url}`, this.timeoutMs);
        if (reconnect && !this.reconnectTimeout) {
            this.handleReconnection();
        }
    }

    /**
     * Handles the connection event when the WebSocket connection is established.
     * This method is called when the WebSocket connection is successfully opened.
     * It clears any existing connection and reconnection timeouts, updates the connection statistics,
     * sets the connection status to `CONNECTED`, and emits `connect` and `ready` events on the `ndkRelay` object.
     */
    private onConnect() {
        this.netDebug?.("connected", this.ndkRelay);
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }
        if (this.connectTimeout) {
            clearTimeout(this.connectTimeout);
            this.connectTimeout = undefined;
        }
        this.updateConnectionStats.connected();
        this._status = NDKRelayStatus.CONNECTED;
        this.authChallenge = undefined;
        this.authedAs = undefined;
        this.authWanted = undefined;

        // disconnect() stops monitoring; a new connection needs it again
        if (!this.wsStateMonitor) this.setupMonitoring();

        // Start keepalive monitoring
        this.keepalive?.start();
        this.wasIdle = false;

        this.ndkRelay.emit("connect");
        this.ndkRelay.emit("ready");

        // REQs that were running on the previous connection
        const retired = [...this.retiredSubs];
        this.retiredSubs.clear();
        for (const sub of retired) sub.resubscribe();
    }

    /**
     * Handles the disconnection event when the WebSocket connection is closed.
     * This method is called when the WebSocket connection is successfully closed.
     * It updates the connection statistics, sets the connection status to `DISCONNECTED`,
     * initiates a reconnection attempt if we didn't disconnect ourselves,
     * and emits a `disconnect` event on the `ndkRelay` object.
     */
    private onDisconnect() {
        this.netDebug?.("disconnected", this.ndkRelay);
        this.updateConnectionStats.disconnected();

        // Stop keepalive when disconnected
        this.keepalive?.stop();

        // Clear any pending publish/auth promises to prevent memory leaks
        this.clearPendingPublishes(new Error(`Relay ${this.ndkRelay.url} disconnected`));
        this.retireConnection();

        if (this._status >= NDKRelayStatus.CONNECTED) {
            this.handleReconnection();
        }
        this._status = NDKRelayStatus.DISCONNECTED;
        this.authChallenge = undefined;
        this.authedAs = undefined;
        this.authWanted = undefined;
        this.ndkRelay.emit("disconnect");
    }

    /**
     * Handles incoming messages from the NDK relay WebSocket connection.
     * This method is called whenever a message is received from the relay.
     * It parses the message data and dispatches the appropriate handling logic based on the message type.
     *
     * @param event - The MessageEvent containing the received message data.
     */
    private onMessage(event: MessageEvent): void {
        this.netDebug?.(event.data, this.ndkRelay, "recv");

        // Record any activity from relay
        this.keepalive?.recordActivity();

        // NOTE: We intentionally DON'T early-return for "already seen" events.
        // The seenEvents optimization was causing a bug: if subscription A sees event X,
        // then subscription B is created later and requests event X, the relay sends it
        // but it was being skipped because it's "already seen" globally.
        //
        // Instead, we let dispatchEvent handle routing to ALL matching subscriptions.
        // Each subscription's eventFirstSeen (checked in eventReceived) will skip
        // re-validation for events it's already processed, maintaining the performance
        // benefit while ensuring new subscriptions receive events they need.
        //
        // The seenEvents tracking in dispatchEvent() is still used for:
        // - exclusiveRelay filtering (checking which relays have sent an event)
        // - Tracking event provenance

        try {
            const data = JSON.parse(event.data);
            const [cmd, id, ..._rest] = data;

            // Check for registered protocol handlers first
            const handler = this.ndkRelay.getProtocolHandler(cmd);
            if (handler) {
                handler(this.ndkRelay, data);
                return;
            }

            const ping = (cmd === "EVENT" || cmd === "EOSE" || cmd === "CLOSED") && this.pings.get(id);
            if (ping) {
                ping(cmd !== "CLOSED");
                return;
            }

            switch (cmd) {
                case "EVENT": {
                    const so = this.openSubs.get(id);
                    const event = data[2] as NostrEvent;
                    if (!so) {
                        this.debug(`Received event for unknown subscription ${id}`);
                        return;
                    }
                    so.onevent(event);
                    return;
                }
                case "COUNT": {
                    const payload = data[2] as { count: number; hll?: string };
                    const cr = this.openCountRequests.get(id) as CountResolver;
                    if (cr) {
                        const result: NDKCountResult = { count: payload.count };
                        // Parse HLL if present (NIP-45 HyperLogLog support)
                        if (payload.hll) {
                            try {
                                result.hll = NDKCountHll.fromHex(payload.hll);
                            } catch (e) {
                                this.debug("Failed to parse HLL from COUNT response:", e);
                            }
                        }
                        cr.resolve(result);
                        this.openCountRequests.delete(id);
                    }
                    return;
                }
                case "EOSE": {
                    const so = this.openSubs.get(id);
                    if (!so) return;
                    so.oneose(id);
                    return;
                }
                case "OK": {
                    const ok: boolean = data[2];
                    const reason: string = data[3];
                    const ep = this.openEventPublishes.get(id) as EventPublishResolver[] | undefined;
                    const firstEp = ep?.pop();

                    if (!ep || !firstEp) {
                        this.debug("Received OK for unknown event publish", id);
                        return;
                    }

                    if (ok) {
                        firstEp.resolve(reason);
                        // Clean up the pending auth publish since it succeeded
                        this.forgetPublish(id);
                    } else {
                        // Check if this is an auth-required error
                        // Different relays use different error messages for auth requirements
                        const isAuthRequired =
                            reason &&
                            (reason.toLowerCase().includes("auth-required") ||
                                reason.toLowerCase().includes("not authorized") ||
                                reason.toLowerCase().includes("blocked: not authorized"));

                        if (isAuthRequired) {
                            // Get the pending event from pendingAuthPublishes
                            const event = this.pendingAuthPublishes.get(id);
                            // Already authenticated (we are simply not allowed) or no policy to
                            // answer with: waiting would only end in the caller's timeout.
                            const canAuth = !!this.authPolicy && this._status !== NDKRelayStatus.AUTHENTICATED;
                            if (event && canAuth) {
                                this.debug("Publish failed due to auth-required, will retry after auth", id);
                                this.authBlocked.add(id);
                                // The caller's publish timeout restarts: AUTH (signing, the relay's
                                // OK) and the re-send are a second round trip it did not budget for.
                                this.authWaitHooks.get(id)?.();
                                if (this._status < NDKRelayStatus.AUTHENTICATING) this.authenticate("auth-required");
                                // Don't reject yet - keep the resolver for retry after auth
                                // Put the resolver back so we can resolve/reject it after auth
                                ep.push(firstEp);
                                this.openEventPublishes.set(id, ep);
                            } else {
                                // Event not found in pending, reject normally
                                firstEp.reject(new Error(reason));
                                this.forgetPublish(id);
                            }
                        } else {
                            firstEp.reject(new Error(reason));
                            // Clean up the pending auth publish for non-auth errors
                            this.forgetPublish(id);
                        }
                    }

                    if (ep.length === 0) {
                        this.openEventPublishes.delete(id);
                    } else if (
                        !ok &&
                        !(
                            reason?.toLowerCase().includes("auth-required") ||
                            reason?.toLowerCase().includes("not authorized") ||
                            reason?.toLowerCase().includes("blocked: not authorized")
                        )
                    ) {
                        // Only clear the publish map if it's not auth-required
                        this.openEventPublishes.set(id, ep);
                    }
                    return;
                }
                case "CLOSED": {
                    const so = this.openSubs.get(id);
                    if (!so) return;
                    so.onclosed(data[2] as string);
                    return;
                }
                case "NOTICE":
                    this.onNotice(data[1] as string);
                    return;
                case "AUTH": {
                    this.onAuthRequested(data[1] as string);
                    return;
                }
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (error: any) {
            this.debug(`Error parsing message from ${this.ndkRelay.url}: ${error.message}`, error?.stack);
            return;
        }
    }

    /**
     * Handles an authentication request from the NDK relay.
     *
     * If an authentication policy is configured, it will be used to authenticate the connection.
     * Otherwise, the `auth` event will be emitted to allow the application to handle the authentication.
     *
     * @param challenge - The authentication challenge provided by the NDK relay.
     */
    private onAuthRequested(challenge: string) {
        this.authChallenge = challenge;
        const authPolicy = this.authPolicy;

        this.debug("Relay requested authentication", { havePolicy: !!authPolicy });

        if (!authPolicy) {
            this.ndkRelay.emit("auth", challenge);
            return;
        }

        // A new challenge on a connection we already authenticated, or one we are
        // answering right now, doesn't need another AUTH.
        if (this._status === NDKRelayStatus.AUTHENTICATED || this.authInFlight) return;

        // A challenge on its own is an offer (many relays send one on every connect). The policy
        // is told so, and may decline it quietly; one that arrives after something was refused
        // with auth-required — or after authenticate() found no challenge — is a need.
        const reason: NDKAuthReason = this.authBlocked.size > 0 ? "auth-required" : (this.authWanted ?? "challenge");
        this.authWanted = undefined;
        this._status = NDKRelayStatus.AUTH_REQUESTED;
        this.authenticate(reason);
    }

    private get authPolicy() {
        return this.ndkRelay.authPolicy ?? this.ndk?.relayAuthDefaultPolicy;
    }

    /**
     * Answers the relay's current NIP-42 challenge with the auth policy.
     *
     * Resolves true once the relay accepts the AUTH event (or the connection is
     * already authenticated), false when there is no challenge or policy, the policy
     * declines, or the relay rejects it. Concurrent calls share one attempt.
     */
    public authenticate(reason: NDKAuthReason = "manual"): Promise<boolean> {
        if (this._status === NDKRelayStatus.AUTHENTICATED) return Promise.resolve(true);
        if (this.authInFlight) return this.authInFlight;

        const challenge = this.authChallenge;
        const authPolicy = this.authPolicy;
        if (!challenge || !authPolicy || !this.connected) {
            // No challenge yet: answer it as a need when it comes, rather than as an offer.
            if (!challenge && authPolicy && this.connected && reason !== "challenge") this.authWanted = reason;
            return Promise.resolve(false);
        }

        const attempt = this.runAuth(authPolicy, challenge, reason).finally(() => {
            if (this.authInFlight === attempt) this.authInFlight = undefined;
        });
        this.authInFlight = attempt;
        return attempt;
    }

    private async runAuth(
        authPolicy: NonNullable<NDKRelay["authPolicy"]>,
        challenge: string,
        reason: NDKAuthReason,
    ): Promise<boolean> {
        const authed = await this.attemptAuth(authPolicy, challenge, reason);
        // Every attempt ends here, however it ended (a quietly declined offer and a connection
        // that changed underneath included), for whoever waits on the outcome.
        this.ndkRelay.emit("auth:settled", authed);
        return authed;
    }

    private async attemptAuth(
        authPolicy: NonNullable<NDKRelay["authPolicy"]>,
        challenge: string,
        reason: NDKAuthReason,
    ): Promise<boolean> {
        this._status = NDKRelayStatus.AUTHENTICATING;

        try {
            let res = await authPolicy(this.ndkRelay, challenge, reason);
            this.debug("Authentication policy returned", !!res, reason);

            // Declining an offer is not a failure: nothing was refused, nothing is waiting on it.
            if (!res && reason === "challenge" && this.authBlocked.size === 0) {
                if (this._status > NDKRelayStatus.CONNECTED) this._status = NDKRelayStatus.CONNECTED;
                return false;
            }

            if (res === true) res = await this.signAuthEvent(challenge);
            if (!(res instanceof NDKEvent)) throw new Error("Authentication declined by policy");

            await this.withAuthTimeout(this.auth(res));

            // the connection changed while we were waiting
            if (this.authChallenge !== challenge || !this.connected) return false;

            this._status = NDKRelayStatus.AUTHENTICATED;
            this.authedAs = res.pubkey;
            this.debug("Authentication successful");
            this.ndkRelay.emit("authed");
            this.retryPendingAuthPublishes();
            return true;
        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            if (this._status > NDKRelayStatus.CONNECTED) this._status = NDKRelayStatus.CONNECTED;
            this.debug("Authentication failed", error);
            this.ndkRelay.emit("auth:failed", error);
            this.rejectPendingAuthPublishes(error);
            return false;
        }
    }

    private async signAuthEvent(challenge: string): Promise<NDKEvent> {
        if (!this.ndk?.signer) {
            this.debug("Waiting for a signer to authenticate");
            // Bounded: a signer that never arrives is a declined AUTH, not a publish held forever.
            let timer: ReturnType<typeof setTimeout> | undefined;
            let onReady: (() => void) | undefined;
            await new Promise<void>((resolve, reject) => {
                onReady = () => resolve();
                this.ndk?.once("signer:ready", onReady);
                timer = setTimeout(() => reject(new Error("No signer to authenticate with")), this.authTimeoutMs);
            }).finally(() => {
                clearTimeout(timer);
                if (onReady) this.ndk?.off("signer:ready", onReady);
            });
        }
        const event = new NDKEvent(this.ndk);
        event.kind = NDKKind.ClientAuth;
        event.tags = [
            ["relay", this.ndkRelay.url],
            ["challenge", challenge],
        ];
        await event.sign();
        return event;
    }

    private withAuthTimeout<T>(p: Promise<T>): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Timed out waiting for AUTH OK")), this.authTimeoutMs);
        });
        return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
    }

    /**
     * Handles errors that occur on the WebSocket connection to the relay.
     * @param error - The error or event that occurred.
     */
    private onError(error: Error | Event): void {
        this.debug(`WebSocket error on ${this.ndkRelay.url}:`, error);
    }

    /**
     * Gets the current status of the NDK relay connection.
     * @returns {NDKRelayStatus} The current status of the NDK relay connection.
     */
    get status(): NDKRelayStatus {
        return this._status;
    }

    /**
     * Checks if the NDK relay connection is currently available.
     * @returns {boolean} `true` if the relay connection is in the `CONNECTED` status, `false` otherwise.
     */
    public isAvailable(): boolean {
        return this._status === NDKRelayStatus.CONNECTED;
    }

    /**
     * Checks if the NDK relay connection is flapping, which means the connection is rapidly
     * disconnecting and reconnecting. This is determined by analyzing the durations of the
     * last three connection attempts. If the standard deviation of the durations is less
     * than 1000 milliseconds, the connection is considered to be flapping.
     *
     * @returns {boolean} `true` if the connection is flapping, `false` otherwise.
     */
    private isFlapping(): boolean {
        const durations = this._connectionStats.durations;
        if (durations.length % 3 !== 0) return false;

        const sum = durations.reduce((a, b) => a + b, 0);
        const avg = sum / durations.length;
        const variance = durations.map((x) => (x - avg) ** 2).reduce((a, b) => a + b, 0) / durations.length;
        const stdDev = Math.sqrt(variance);
        const isFlapping = stdDev < FLAPPING_THRESHOLD_MS;

        return isFlapping;
    }

    /**
     * Handles a notice received from the NDK relay.
     * If the notice indicates the relay is complaining (e.g. "too many" or "maximum"),
     * the method disconnects from the relay and attempts to reconnect after a 2-second delay.
     * A debug message is logged with the relay URL and the notice text.
     * The "notice" event is emitted on the ndkRelay instance with the notice text.
     *
     * @param notice - The notice text received from the NDK relay.
     */
    private async onNotice(notice: string) {
        this.ndkRelay.emit("notice", notice);
    }

    /**
     * Attempts to reconnect to the NDK relay after a connection is lost.
     * This function is called recursively to handle multiple reconnection attempts.
     * It checks if the relay is flapping and emits a "flapping" event if so.
     * It then calculates a delay before the next reconnection attempt based on the number of previous attempts.
     * The function sets a timeout to execute the next reconnection attempt after the calculated delay.
     * If the maximum number of reconnection attempts is reached, a debug message is logged.
     *
     * @param attempt - The current attempt number (default is 0).
     */
    private handleReconnection(attempt = 0): void {
        if (this.reconnectTimeout) return;

        if (this.isFlapping()) {
            this.ndkRelay.emit("flapping", this._connectionStats);
            this._status = NDKRelayStatus.FLAPPING;
            return;
        }

        // Calculate reconnect delay based on whether we were idle
        let reconnectDelay: number;

        if (this.wasIdle) {
            // After idle/sleep, use aggressive reconnection: 0s, 1s, 2s, 5s, 10s, 30s
            const aggressiveDelays = [0, 1000, 2000, 5000, 10000, 30000];
            reconnectDelay = aggressiveDelays[Math.min(attempt, aggressiveDelays.length - 1)];
            this.debug(`Using aggressive reconnect after idle, attempt ${attempt}, delay ${reconnectDelay}ms`);
        } else if (this.connectedAt) {
            // Recent disconnection, wait before reconnecting
            reconnectDelay = Math.max(0, 60000 - (Date.now() - this.connectedAt));
        } else {
            // Standard exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s max
            reconnectDelay = Math.min(1000 * 2 ** attempt, 30000);
            this.debug(`Using standard backoff, attempt ${attempt}, delay ${reconnectDelay}ms`);
        }

        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = undefined;
            this._status = NDKRelayStatus.RECONNECTING;

            this.connect().catch(() => {
                // Always keep retrying with backoff
                this.handleReconnection(attempt + 1);
            });
        }, reconnectDelay);

        this.ndkRelay.emit("delayed-connect", reconnectDelay);
        this.debug("Reconnecting in", reconnectDelay);
        this._connectionStats.nextReconnectAt = Date.now() + reconnectDelay;
    }

    /**
     * Sends a message to the NDK relay if the connection is in the CONNECTED state and the WebSocket is open.
     * If the connection is not in the CONNECTED state or the WebSocket is not open, logs a debug message and throws an error.
     *
     * @param message - The message to send to the NDK relay.
     * @throws {Error} If attempting to send on a closed relay connection.
     */
    async send(message: string) {
        // Check if we've been idle for a while
        const idleTime = Date.now() - this.lastMessageSent;
        if (idleTime > 120000) {
            // 2 minutes
            this.wasIdle = true;
        }

        if (this._status >= NDKRelayStatus.CONNECTED && this.ws?.readyState === WebSocket.OPEN) {
            this.ws?.send(message);
            this.netDebug?.(message, this.ndkRelay, "send");
            this.lastMessageSent = Date.now();
        } else {
            this.debug(`Not connected to ${this.ndkRelay.url} (%d), not sending message ${message}`, this._status);

            // If we think we're connected but WebSocket is not open, we have a stale connection
            if (this._status >= NDKRelayStatus.CONNECTED && this.ws?.readyState !== WebSocket.OPEN) {
                this.debug(`Stale connection detected, WebSocket state: ${this.ws?.readyState}`);
                // Force disconnect and reconnect
                this.handleStaleConnection();
            }
        }
    }

    /**
     * Authenticates the NDK event by sending it to the NDK relay and returning a promise that resolves with the result.
     *
     * @param event - The NDK event to authenticate.
     * @returns A promise that resolves with the authentication result.
     */
    private async auth(event: NDKEvent): Promise<string> {
        const ret = new Promise<string>((resolve, reject) => {
            const val = this.openEventPublishes.get(event.id) ?? [];
            val.push({ resolve, reject });
            this.openEventPublishes.set(event.id, val);
        });
        this.send(`["AUTH",${JSON.stringify(event.rawEvent())}]`);
        return ret;
    }

    /**
     * Clears all pending publish promises by rejecting them with the provided error.
     * This is called on disconnection to prevent memory leaks and ensure promises
     * don't hang indefinitely.
     * @param error The error to reject the promises with
     */
    private clearPendingPublishes(error: Error): void {
        // Reject any promises waiting for auth-required retry
        // rejectPendingAuthPublishes handles both pendingAuthPublishes and openEventPublishes
        this.rejectPendingAuthPublishes(error);

        // Clear any other outstanding publishes not related to auth
        for (const [eventId, resolvers] of this.openEventPublishes.entries()) {
            while (resolvers.length > 0) {
                const resolver = resolvers.shift();
                if (resolver) {
                    resolver.reject(error);
                }
            }
            this.openEventPublishes.delete(eventId);
        }
        this.pendingAuthPublishes.clear();
        this.authWaitHooks.clear();
    }

    /**
     * Retries all pending publishes that failed due to auth-required.
     * Called after successful authentication.
     */
    private retryPendingAuthPublishes(): void {
        if (this.authBlocked.size === 0) return;

        this.debug(`Retrying ${this.authBlocked.size} pending publishes after auth`);

        // Only the ones the relay refused: a publish still waiting on its first OK was not refused
        // and re-sending it would only make a duplicate. The re-sent ones stay in
        // pendingAuthPublishes until their OK, like any publish.
        for (const eventId of this.authBlocked) {
            const event = this.pendingAuthPublishes.get(eventId);
            if (!event) continue;
            this.debug(`Retrying publish for event ${eventId}`);
            this.send(`["EVENT",${JSON.stringify(event)}]`);
        }
        this.authBlocked.clear();
    }

    /**
     * Rejects all pending publishes that failed due to auth-required.
     * Called when authentication fails.
     */
    private rejectPendingAuthPublishes(error: Error): void {
        if (this.authBlocked.size === 0) return;

        this.debug(`Rejecting ${this.authBlocked.size} pending publishes due to auth failure`);

        // Only the ones waiting on AUTH: a failed or declined AUTH says nothing about a publish
        // the relay has not refused, and that one gets its own OK.
        for (const eventId of [...this.authBlocked]) {
            const ep = this.openEventPublishes.get(eventId);
            if (ep && ep.length > 0) {
                const resolver = ep.pop();
                if (resolver) {
                    resolver.reject(new Error(`Authentication failed: ${error.message}`));
                }

                if (ep.length === 0) {
                    this.openEventPublishes.delete(eventId);
                }
            }
            this.forgetPublish(eventId);
        }
    }

    private forgetPublish(eventId: string): void {
        this.pendingAuthPublishes.delete(eventId);
        this.authBlocked.delete(eventId);
        this.authWaitHooks.delete(eventId);
    }

    /**
     * Publishes an NDK event to the relay and returns a promise that resolves with the result.
     *
     * @param event - The NDK event to publish.
     * @returns A promise that resolves with the result of the event publication.
     * @throws {Error} If attempting to publish on a closed relay connection.
     */
    async publish(event: NostrEvent, onAuthWait?: () => void): Promise<string> {
        const ret = new Promise<string>((resolve, reject) => {
            const val = this.openEventPublishes.get(event.id!) ?? [];
            if (val.length > 0) {
                console.warn(`Duplicate event publishing detected, you are publishing event ${event.id!} twice`);
            }

            val.push({ resolve, reject });
            this.openEventPublishes.set(event.id!, val);
        });

        // Store the event in case we need to retry after auth
        this.pendingAuthPublishes.set(event.id!, event);
        if (onAuthWait) this.authWaitHooks.set(event.id!, onAuthWait);

        this.send(`["EVENT",${JSON.stringify(event)}]`);
        return ret;
    }

    /**
     * Counts the number of events that match the provided filters.
     *
     * @param filters - The filters to apply to the count request.
     * @param params - An optional object containing a custom id for the count request.
     * @returns A promise that resolves with the count result including optional HLL data.
     * @throws {Error} If attempting to send the count request on a closed relay connection.
     */
    async count(filters: NDKFilter[], params: { id?: string | null }): Promise<NDKCountResult> {
        this.serial++;
        const id = params?.id || `count:${this.serial}`;
        const ret = new Promise<NDKCountResult>((resolve, reject) => {
            this.openCountRequests.set(id, { resolve, reject });
        });
        this.send(JSON.stringify(["COUNT", id, ...filters]));
        return ret;
    }

    public close(subId: string, reason?: string): void {
        this.send(JSON.stringify(["CLOSE", subId]));
        const sub = this.openSubs.get(subId);
        this.openSubs.delete(subId);
        if (sub) sub.onclose(reason);
    }

    /**
     * Subscribes to the NDK relay with the provided filters and parameters.
     *
     * @param filters - The filters to apply to the subscription.
     * @param params - The subscription parameters, including an optional custom id.
     * @returns A new NDKRelaySubscription instance.
     */
    /**
     * Asks the relay something it must answer (a REQ for nothing) and resolves true
     * when it answers that REQ — EVENT, EOSE or CLOSED — or false after `timeoutMs`.
     * Other traffic on the socket doesn't count. Concurrent calls share one probe.
     */
    public ping(timeoutMs = 3_000): Promise<boolean> {
        if (!this.connected) return Promise.resolve(false);
        if (this.pingInFlight) return this.pingInFlight;

        const id = `ping-${++this.serial}-${Math.random().toString(36).substring(2, 7)}`;
        const probe = new Promise<boolean>((resolve) => {
            const done = (answered: boolean, closeReq: boolean) => {
                clearTimeout(timer);
                this.pings.delete(id);
                if (closeReq) this.send(JSON.stringify(["CLOSE", id]));
                resolve(answered);
            };
            const timer = setTimeout(() => done(false, true), timeoutMs);
            // a CLOSED already ended the REQ
            this.pings.set(id, (stillOpen) => done(true, stillOpen));
            this.send(JSON.stringify(["REQ", id, { kinds: [0], limit: 0 }]));
        }).finally(() => {
            if (this.pingInFlight === probe) this.pingInFlight = undefined;
        });
        this.pingInFlight = probe;
        return probe;
    }

    /**
     * Replaces the current socket with a new one, also while the old one is still
     * closing. Running subscriptions are re-sent on the new connection.
     */
    public async reconnect(timeoutMs?: number): Promise<void> {
        if (this.ws || this._status >= NDKRelayStatus.CONNECTED || this._status === NDKRelayStatus.DISCONNECTING) {
            const closed = new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, timeoutMs ?? 3_000);
                this.ndkRelay.once("disconnect", () => {
                    clearTimeout(timer);
                    resolve();
                });
            });
            if (this._status !== NDKRelayStatus.DISCONNECTING) this.disconnect();
            await closed;
            // The old socket never reported closing: let it go.
            if (this.ws || this._status !== NDKRelayStatus.DISCONNECTED) {
                this.dropSocket();
                this.retireConnection();
                this._status = NDKRelayStatus.DISCONNECTED;
            }
        }
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }

        const connected = new Promise<void>((resolve) => this.ndkRelay.once("ready", () => resolve()));
        await this.connect(timeoutMs);
        await connected;
    }

    /** Closes the socket without letting its later events reach this connection. */
    private dropSocket(): void {
        const ws = this.ws;
        this.ws = undefined;
        if (!ws) return;
        ws.onopen = null;
        ws.onclose = null;
        ws.onmessage = null;
        ws.onerror = null;
        try {
            ws.close();
        } catch {
            // already dead
        }
    }

    /** The REQs on this connection end with it; running ones are re-sent on the next one. */
    private retireConnection(): void {
        for (const sub of this.openSubs.values()) this.retiredSubs.add(sub);
        this.openSubs.clear();
        this.pings.clear();
    }

    public req(relaySub: NDKRelaySubscription): void {
        // A REQ needs at least one filter; ["REQ","id"] is rejected by relays.
        if (!relaySub.executeFilters?.length) {
            this.debug("Not sending a REQ with no filters", relaySub.subId);
            return;
        }
        this.send(JSON.stringify(["REQ", relaySub.subId, ...relaySub.executeFilters]));
        this.openSubs.set(relaySub.subId, relaySub);
    }

    /**
     * Utility functions to update the connection stats.
     */
    private updateConnectionStats = {
        connected: () => {
            this._connectionStats.success++;
            this._connectionStats.connectedAt = Date.now();
        },

        disconnected: () => {
            if (this._connectionStats.connectedAt) {
                this._connectionStats.durations.push(Date.now() - this._connectionStats.connectedAt);

                if (this._connectionStats.durations.length > 100) {
                    this._connectionStats.durations.shift();
                }
            }
            this._connectionStats.connectedAt = undefined;
        },

        attempt: () => {
            this._connectionStats.attempts++;
            this._connectionStats.connectedAt = Date.now();
        },
    };

    /** Returns the connection stats. */
    get connectionStats(): NDKRelayConnectionStats {
        return this._connectionStats;
    }

    /** Returns the relay URL */
    get url(): WebSocket["url"] {
        return this.ndkRelay.url;
    }

    get connected(): boolean {
        return this._status >= NDKRelayStatus.CONNECTED && this.ws?.readyState === WebSocket.OPEN;
    }
}
