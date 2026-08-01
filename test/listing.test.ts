import { describe, it, expect } from "vitest";
import {
    slugify,
    validateDraft,
    draftToListing,
    validateInput,
    priceFor,
    slugFromPath,
    type ListingDraft,
} from "../src/core/listing.js";

const valid: ListingDraft = {
    name: "Sentiment Classifier",
    description: "Classifies the sentiment of a block of text as positive, negative or neutral.",
    upstreamUrl: "http://localhost:4030/sentiment",
    priceTinybar: 2_000_000,
    payToAccount: "0.0.9864248",
    inputSchema: { text: { type: "string", required: true, description: "Text to classify" } },
};

const errorFields = (draft: ListingDraft) => validateDraft(draft).map((e) => e.field);

describe("slugify", () => {
    it("turns a display name into a url-safe slug", () => {
        expect(slugify("Sentiment Classifier")).toBe("sentiment-classifier");
        expect(slugify("  Web Page  Digest!! ")).toBe("web-page-digest");
    });
});

describe("validateDraft", () => {
    it("accepts a well-formed listing", () => {
        expect(validateDraft(valid)).toEqual([]);
    });

    it("rejects a non-Hedera payee", () => {
        expect(errorFields({ ...valid, payToAccount: "0xdeadbeef" })).toContain("payToAccount");
    });

    it("rejects a non-positive price", () => {
        expect(errorFields({ ...valid, priceTinybar: 0 })).toContain("priceTinybar");
        expect(errorFields({ ...valid, priceTinybar: -5 })).toContain("priceTinybar");
    });

    it("rejects an implausibly large price, which is almost always a unit mistake", () => {
        expect(errorFields({ ...valid, priceTinybar: 999_999_999_999 })).toContain("priceTinybar");
    });

    it("rejects a fractional price — tinybar is the atomic unit", () => {
        expect(errorFields({ ...valid, priceTinybar: 1.5 })).toContain("priceTinybar");
    });

    it("rejects a non-http upstream", () => {
        expect(errorFields({ ...valid, upstreamUrl: "ftp://example.com" })).toContain("upstreamUrl");
        expect(errorFields({ ...valid, upstreamUrl: "not a url" })).toContain("upstreamUrl");
    });

    it("requires a description long enough for a buying agent to act on", () => {
        expect(errorFields({ ...valid, description: "does stuff" })).toContain("description");
    });
});

describe("draftToListing", () => {
    it("derives a slug and normalises tags", () => {
        const listing = draftToListing({ ...valid, tags: ["  NLP ", "Text", ""] });
        expect(listing.slug).toBe("sentiment-classifier");
        expect(listing.tags).toEqual(["nlp", "text"]);
    });
});

describe("validateInput", () => {
    const listing = draftToListing(valid);

    it("passes when required fields are present", () => {
        expect(validateInput(listing, { text: "hello" })).toEqual([]);
    });

    it("flags a missing required field", () => {
        expect(validateInput(listing, {}).map((e) => e.field)).toEqual(["text"]);
    });

    it("flags a wrongly typed field", () => {
        expect(validateInput(listing, { text: 42 }).map((e) => e.field)).toEqual(["text"]);
    });
});

describe("priceFor", () => {
    // Passing a bare number here fails x402 verification silently, with a
    // second 402 and no explanation. Pin the shape.
    it("produces the {amount, asset} shape x402 requires", () => {
        expect(priceFor(draftToListing(valid))).toEqual({ amount: "2000000", asset: "0.0.0" });
    });
});

describe("slugFromPath", () => {
    it("extracts the slug from a hire path", () => {
        expect(slugFromPath("/a/sentiment")).toBe("sentiment");
        expect(slugFromPath("/a/url-digest?x=1")).toBe("url-digest");
    });
});
