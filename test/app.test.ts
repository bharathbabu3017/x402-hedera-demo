import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../src/server/app.js";
import { MarketplaceStore } from "../src/core/store.js";
import { draftToListing, newOwnerToken } from "../src/core/listing.js";
import type { ServerConfig } from "../src/core/config.js";

const config: ServerConfig = {
    hederaNetwork: "hedera:testnet",
    facilitatorUrl: "https://api.testnet.blocky402.com",
    payToAccount: "0.0.1111",
    sellerBAccount: "0.0.2222",
    mirrorNodeUrl: "https://testnet.mirrornode.hedera.com",
    databasePath: ":memory:",
    sellerBaseUrl: "http://localhost:4030",
    port: 4021,
};

const draft = {
    slug: "sentiment",
    name: "Sentiment Classifier",
    description: "Classifies the sentiment of a block of text as positive, negative or neutral.",
    upstreamUrl: "http://localhost:4030/sentiment",
    priceTinybar: 2_000_000,
    payToAccount: "0.0.2222",
    inputSchema: { text: { type: "string" as const, required: true, description: "Text" } },
};

let store: MarketplaceStore;
let app: ReturnType<typeof createApp>;

/** Hono's `.json()` is typed `unknown`; tests assert on known shapes. */
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

interface Listed {
    ownerToken: string;
    hireUrl: string;
    listing: { priceTinybar: number };
}
interface Registry {
    listings: Array<{ slug: string }>;
}
interface Errors {
    errors: Array<{ field: string }>;
}
interface Activity {
    calls: Array<{ txUrl: string; agentName: string }>;
}

// Every account is assumed to exist unless a test says otherwise — keeps the
// suite offline.
const makeApp = (verifyAccount = async () => true) => {
    store = new MarketplaceStore(":memory:");
    app = createApp({ store, config, verifyAccount });
};

beforeEach(() => makeApp());

describe("discovery is free", () => {
    it("serves an empty registry", async () => {
        const res = await app.request("/registry");
        expect(res.status).toBe(200);
        expect((await json<Registry>(res)).listings).toEqual([]);
    });

    it("404s an unknown agent", async () => {
        expect((await app.request("/registry/nope")).status).toBe(404);
    });

    it("does not treat /registry/search as a slug", async () => {
        const res = await app.request("/registry/search?q=anything");
        expect(res.status).toBe(200);
        expect((await json<Registry>(res)).listings).toEqual([]);
    });
});

describe("listing an agent", () => {
    const post = (body: unknown) =>
        app.request("/registry", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });

    it("creates a listing and returns the owner token exactly once", async () => {
        const res = await post(draft);
        expect(res.status).toBe(201);
        const body = await json<Listed>(res);
        expect(body.ownerToken).toMatch(/^[0-9a-f]{48}$/);
        expect(body.hireUrl).toMatch(/\/a\/sentiment$/);

        // The token must never appear on a subsequent read.
        const read = await json<{ listing: Record<string, unknown> }>(
            await app.request("/registry/sentiment"),
        );
        expect(read.listing["ownerToken"]).toBeUndefined();
        expect(JSON.stringify(read)).not.toContain(body.ownerToken);
    });

    it("rejects a duplicate slug", async () => {
        await post(draft);
        expect((await post(draft)).status).toBe(409);
    });

    it("rejects a payee that does not exist on the network", async () => {
        makeApp(async () => false);
        const res = await post(draft);
        expect(res.status).toBe(400);
        expect((await json<Errors>(res)).errors[0]?.field).toBe("payToAccount");
    });

    it("rejects an invalid draft with per-field errors", async () => {
        const res = await post({ ...draft, priceTinybar: -1, payToAccount: "nope" });
        expect(res.status).toBe(400);
        const fields = (await json<Errors>(res)).errors.map((e) => e.field);
        expect(fields).toContain("priceTinybar");
        expect(fields).toContain("payToAccount");
    });
});

describe("editing a listing", () => {
    const patch = (body: unknown, token?: string) =>
        app.request("/registry/sentiment", {
            method: "PATCH",
            headers: {
                "content-type": "application/json",
                ...(token ? { "x-owner-token": token } : {}),
            },
            body: JSON.stringify(body),
        });

    it("requires the owner token", async () => {
        store.insert(draftToListing(draft), newOwnerToken());
        expect((await patch({ priceTinybar: 1 })).status).toBe(403);
        expect((await patch({ priceTinybar: 1 }, "wrong")).status).toBe(403);
    });

    it("applies a valid patch when the token matches", async () => {
        const token = newOwnerToken();
        store.insert(draftToListing(draft), token);
        const res = await patch({ priceTinybar: 4_000_000 }, token);
        expect(res.status).toBe(200);
        expect((await json<Listed>(res)).listing.priceTinybar).toBe(4_000_000);
    });

    it("validates the merged result, so a patch cannot bypass field rules", async () => {
        const token = newOwnerToken();
        store.insert(draftToListing(draft), token);
        expect((await patch({ priceTinybar: -10 }, token)).status).toBe(400);
    });
});

describe("activity feed", () => {
    it("links every settled call to its proof on HashScan", async () => {
        store.insert(draftToListing(draft), newOwnerToken());
        store.recordCall({
            slug: "sentiment",
            tinybar: 2_000_000,
            txId: "0.0.7162784@1785546426.941066223",
            payer: "0.0.9858234",
        });

        const body = await json<Activity>(await app.request("/activity"));
        expect(body.calls).toHaveLength(1);
        expect(body.calls[0]?.txUrl).toBe(
            "https://hashscan.io/testnet/transaction/1785546426.941066223",
        );
        expect(body.calls[0]?.agentName).toBe("Sentiment Classifier");
    });
});
