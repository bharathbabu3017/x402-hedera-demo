import { describe, it, expect } from "vitest";
import {
    buildInput,
    extractText,
    PlanError,
    projectedCost,
    unknownSlugs,
    type PlanStep,
    type PricedListing,
} from "../src/core/plan.js";

const listing = (over: Partial<PricedListing> = {}): PricedListing => ({
    slug: "sentiment",
    priceTinybar: 2_000_000,
    inputSchema: { text: { type: "string", required: true, description: "Text" } },
    ...over,
});

const step = (over: Partial<PlanStep> = {}): PlanStep => ({
    slug: "sentiment",
    reason: "because",
    input: [{ name: "text", value: "hello" }],
    usesOutputOf: null,
    outputIntoField: null,
    ...over,
});

const catalogue = new Map<string, PricedListing>([
    ["sentiment", listing()],
    ["url-summarize", listing({ slug: "url-summarize", priceTinybar: 5_000_000 })],
]);

describe("extractText", () => {
    it("passes a string through", () => {
        expect(extractText("hello")).toBe("hello");
    });

    // Chaining only works if we can find the prose inside an arbitrary result.
    it("finds the prose field in an agent result", () => {
        expect(extractText({ url: "x", summary: "the summary" })).toBe("the summary");
        expect(extractText({ url: "x", digest: "the digest" })).toBe("the digest");
    });

    it("prefers summary over digest when both are present", () => {
        expect(extractText({ summary: "a", digest: "b" })).toBe("a");
    });

    it("falls back to json when there is no obvious text field", () => {
        expect(extractText({ usd: 62926 })).toBe('{"usd":62926}');
    });
});

describe("projectedCost", () => {
    it("sums the listed price of every step", () => {
        expect(projectedCost([step(), step({ slug: "url-summarize" })], catalogue)).toBe(7_000_000);
    });

    it("is zero for an empty plan", () => {
        expect(projectedCost([], catalogue)).toBe(0);
    });
});

describe("unknownSlugs", () => {
    it("catches an agent the model invented", () => {
        expect(unknownSlugs([step({ slug: "does-not-exist" })], catalogue)).toEqual([
            "does-not-exist",
        ]);
    });

    it("is empty when every slug is real", () => {
        expect(unknownSlugs([step()], catalogue)).toEqual([]);
    });
});

describe("buildInput", () => {
    it("turns name/value pairs into a request body", () => {
        expect(buildInput(step(), listing(), [])).toEqual({ text: "hello" });
    });

    it("splices an earlier step's output into the named field", () => {
        const chained = step({
            input: [{ name: "text", value: "PLACEHOLDER" }],
            usesOutputOf: 0,
            outputIntoField: "text",
        });
        const built = buildInput(chained, listing(), [{ summary: "the summary of step one" }]);
        expect(built).toEqual({ text: "the summary of step one" });
    });

    it("throws when the referenced step produced nothing", () => {
        const chained = step({ usesOutputOf: 3, outputIntoField: "text" });
        expect(() => buildInput(chained, listing(), [])).toThrow(PlanError);
    });

    // Plan values always arrive as strings; a numeric field would fail the
    // gateway's input validation without this.
    it("coerces a declared number field", () => {
        const numeric = listing({
            inputSchema: { count: { type: "number", required: true, description: "How many" } },
        });
        const built = buildInput(step({ input: [{ name: "count", value: "42" }] }), numeric, []);
        expect(built).toEqual({ count: 42 });
    });

    it("leaves an unparseable number alone rather than sending NaN", () => {
        const numeric = listing({
            inputSchema: { count: { type: "number", required: true, description: "How many" } },
        });
        const built = buildInput(step({ input: [{ name: "count", value: "abc" }] }), numeric, []);
        expect(built).toEqual({ count: "abc" });
    });
});
