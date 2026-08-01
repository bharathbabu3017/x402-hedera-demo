import { describe, it, expect, beforeEach } from "vitest";
import { MarketplaceStore } from "../src/core/store.js";
import { draftToListing, newOwnerToken, type ListingDraft } from "../src/core/listing.js";

const draft = (over: Partial<ListingDraft> = {}): ListingDraft => ({
    slug: "sentiment",
    name: "Sentiment Classifier",
    description: "Classifies the sentiment of a block of text as positive, negative or neutral.",
    tags: ["nlp"],
    upstreamUrl: "http://localhost:4030/sentiment",
    priceTinybar: 2_000_000,
    payToAccount: "0.0.2222",
    ...over,
});

let store: MarketplaceStore;
beforeEach(() => {
    store = new MarketplaceStore(":memory:");
});

const add = (over: Partial<ListingDraft> = {}) =>
    store.insert(draftToListing(draft(over)), newOwnerToken());

describe("listings", () => {
    it("round-trips a listing including its json columns", () => {
        add({ inputSchema: { text: { type: "string", required: true, description: "Text" } } });
        const listing = store.get("sentiment")!;
        expect(listing.tags).toEqual(["nlp"]);
        expect(listing.inputSchema["text"]?.required).toBe(true);
    });

    it("returns undefined for a missing slug", () => {
        expect(store.get("nope")).toBeUndefined();
    });

    it("searches over name, description and tags", () => {
        add();
        add({
            slug: "crypto-price",
            name: "Crypto Spot Price",
            description: "Returns the current USD spot price for a cryptocurrency by CoinGecko id.",
            tags: ["market-data"],
        });

        expect(store.search("sentiment").map((l) => l.slug)).toEqual(["sentiment"]);
        expect(store.search(undefined, "market-data").map((l) => l.slug)).toEqual(["crypto-price"]);
        expect(store.search("classifies").map((l) => l.slug)).toEqual(["sentiment"]);
        expect(store.search("nothing-matches")).toEqual([]);
    });
});

describe("earnings", () => {
    it("reports zero before any call", () => {
        add();
        const listing = store.get("sentiment")!;
        expect(listing.calls).toBe(0);
        expect(listing.earnedTinybar).toBe(0);
    });

    // Earnings are derived from the ledger rather than a stored counter, so
    // they can't drift from what actually settled on-chain.
    it("derives calls and earnings from the settled-call ledger", () => {
        add();
        store.recordCall({ slug: "sentiment", tinybar: 2_000_000, txId: "t1", payer: "0.0.1" });
        store.recordCall({ slug: "sentiment", tinybar: 2_000_000, txId: "t2", payer: "0.0.1" });

        const listing = store.get("sentiment")!;
        expect(listing.calls).toBe(2);
        expect(listing.earnedTinybar).toBe(4_000_000);
    });

    it("does not attribute one agent's calls to another", () => {
        add();
        add({ slug: "crypto-price", name: "Crypto Spot Price" });
        store.recordCall({ slug: "sentiment", tinybar: 2_000_000, txId: "t1", payer: "0.0.1" });

        expect(store.get("crypto-price")!.earnedTinybar).toBe(0);
    });
});

describe("recentCalls", () => {
    it("returns newest first", () => {
        add();
        store.recordCall({ slug: "sentiment", tinybar: 1, txId: "first", payer: "0.0.1" });
        store.recordCall({ slug: "sentiment", tinybar: 1, txId: "second", payer: "0.0.1" });
        expect(store.recentCalls().map((c) => c.txId)).toEqual(["second", "first"]);
    });
});
