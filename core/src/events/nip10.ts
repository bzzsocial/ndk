import { nip19 } from "nostr-tools";
import type { NDKTag } from "./index.js";

const MARKERS = new Set(["root", "reply", "mention"]);

/** An e-tag's NIP-10 marker, also accepting the malformed shape where it sits in the relay slot
 * (`["e", id, "root", pubkey]`, seen in the wild). */
function markerOf(tag: NDKTag): { marker?: string; inRelaySlot: boolean } {
    if (MARKERS.has(tag[3])) return { marker: tag[3], inRelaySlot: false };
    if (MARKERS.has(tag[2])) return { marker: tag[2], inRelaySlot: true };
    return { inRelaySlot: false };
}

/** A pubkey as lowercase hex, from hex or an npub; undefined for anything else. */
function hexPubkey(value?: string): string | undefined {
    if (!value) return undefined;
    if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
    if (value.startsWith("npub1")) {
        try {
            const decoded = nip19.decode(value);
            if (decoded.type === "npub") return decoded.data;
        } catch {
            // not an npub after all
        }
    }
    return undefined;
}

/**
 * NIP-10 tags for a kind-1 reply to `parent`: one `root` e-tag (the parent's own root, or the
 * parent itself when it isn't a reply), one `reply` e-tag for the parent, the parent's `a` tags
 * when it is a reply, its `p` tags (as hex, deduped) plus the parent's author, and its `h` tags.
 *
 * The parent's own `reply` marker (pointing at the grandparent) and its `mention` e-tags are not
 * carried: a reply has exactly one `reply` marker, for the event it answers.
 */
export function nip10ReplyTags(
    parent: { id: string; pubkey: string; tags?: NDKTag[] },
    opts: { relayHint?: string; pTags?: boolean } = {},
): NDKTag[] {
    const tags = parent.tags ?? [];
    const relayHint = opts.relayHint ?? "";
    const eTags = tags.filter((t) => t[0] === "e" && t[1]);

    // Marked root first; else the legacy positional convention's root (first unmarked e-tag).
    const rootSource = eTags.find((t) => markerOf(t).marker === "root") ?? eTags.find((t) => !markerOf(t).marker);

    const out: NDKTag[] = [];
    if (rootSource && rootSource[1] !== parent.id) {
        const { inRelaySlot } = markerOf(rootSource);
        const relay = inRelaySlot ? "" : (rootSource[2] ?? "");
        const author = hexPubkey(inRelaySlot ? rootSource[3] : rootSource[4]);
        out.push(["e", rootSource[1], relay, "root", ...(author ? [author] : [])]);
        out.push(["e", parent.id, relayHint, "reply", parent.pubkey]);
        // e.g. a comment thread rooted on an article's coordinate
        out.push(...tags.filter((t) => t[0] === "a"));
    } else {
        out.push(["e", parent.id, relayHint, "root", parent.pubkey]);
    }

    if (opts.pTags !== false) {
        const seen = new Set<string>();
        for (const t of tags) {
            const hex = t[0] === "p" ? hexPubkey(t[1]) : undefined;
            if (!hex || seen.has(hex)) continue;
            seen.add(hex);
            out.push(hex === t[1] ? t : ["p", hex, ...t.slice(2)]);
        }
        if (parent.pubkey && !seen.has(parent.pubkey)) out.push(["p", parent.pubkey]);
    }

    // NIP-29 group scope
    out.push(...tags.filter((t) => t[0] === "h"));
    return out;
}
