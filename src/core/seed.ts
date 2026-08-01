import type { ListingDraft } from "./listing.js";
import { draftToListing, newOwnerToken } from "./listing.js";
import type { MarketplaceStore } from "./store.js";
import type { ServerConfig } from "./config.js";

/**
 * `sentiment` is deliberately absent. It runs on the seller service but stays
 * unlisted so it can be listed live on camera — proving a brand-new seller gets
 * discovered and paid by an agent that has never seen them before.
 */
export const seedDrafts = (config: ServerConfig): ListingDraft[] => {
    const upstream = (path: string) => `${config.sellerBaseUrl.replace(/\/$/, "")}${path}`;
    const A = config.payToAccount;
    const B = config.sellerBAccount;

    return [
        {
            slug: "crypto-price",
            name: "Crypto Spot Price",
            description:
                "Returns the current USD spot price for a cryptocurrency by CoinGecko id, e.g. bitcoin or ethereum. Live market data, no API key required.",
            tags: ["crypto", "market-data", "price"],
            upstreamUrl: upstream("/crypto-price"),
            priceTinybar: 1_000_000, // 0.01 ℏ
            payToAccount: A,
            inputSchema: {
                coin: { type: "string", required: true, description: "CoinGecko coin id, e.g. 'bitcoin'" },
            },
            outputExample: { coin: "bitcoin", usd: 94231.5, asOf: "2026-08-01T00:00:00.000Z" },
        },
        {
            slug: "url-summarize",
            name: "Web Page Summarizer",
            description:
                "Fetches a web page and returns a thorough multi-paragraph summary of its content, preserving key facts, figures and named entities. Best when you need detail.",
            tags: ["web", "summarization", "research"],
            upstreamUrl: upstream("/url-summarize"),
            priceTinybar: 5_000_000, // 0.05 ℏ
            payToAccount: B,
            inputSchema: {
                url: { type: "string", required: true, description: "Public http(s) URL to summarize" },
            },
            outputExample: { url: "https://example.com", summary: "…", words: 180 },
        },
        {
            // Deliberately overlaps with url-summarize at a lower price, so the
            // buying agent has a genuine cost/quality decision to justify.
            slug: "url-digest",
            name: "Web Page Digest",
            description:
                "Fetches a web page and returns a short two-sentence digest of what it is about. Cheaper and faster than a full summary; use when a brief gist is enough.",
            tags: ["web", "summarization"],
            upstreamUrl: upstream("/url-digest"),
            priceTinybar: 2_000_000, // 0.02 ℏ
            payToAccount: B,
            inputSchema: {
                url: { type: "string", required: true, description: "Public http(s) URL to digest" },
            },
            outputExample: { url: "https://example.com", digest: "…" },
        },
        {
            slug: "entity-extract",
            name: "Entity Extractor",
            description:
                "Extracts named entities from a block of text — people, organizations, locations, dates and monetary amounts — and returns them grouped by type.",
            tags: ["nlp", "extraction", "text"],
            upstreamUrl: upstream("/entity-extract"),
            priceTinybar: 3_000_000, // 0.03 ℏ
            payToAccount: A,
            inputSchema: {
                text: { type: "string", required: true, description: "Text to extract entities from" },
            },
            outputExample: { people: ["Ada Lovelace"], organizations: [], locations: ["London"] },
        },
    ];
};

/** Idempotent: only inserts listings that aren't already present. */
export const seedIfEmpty = (store: MarketplaceStore, config: ServerConfig): number => {
    let inserted = 0;
    for (const draft of seedDrafts(config)) {
        if (store.get(draft.slug!)) continue;
        store.insert(draftToListing(draft), newOwnerToken());
        inserted += 1;
    }
    return inserted;
};
