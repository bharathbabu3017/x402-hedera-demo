import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ServerConfig } from "../core/config.js";
import type { MarketplaceStore } from "../core/store.js";
import {
    draftToListing,
    newOwnerToken,
    slugify,
    validateDraft,
    type ListingDraft,
} from "../core/listing.js";
import { accountExists } from "../core/mirror.js";
import { hashscanAccount, hashscanTx } from "../core/hashscan.js";

export interface AppDeps {
    store: MarketplaceStore;
    config: ServerConfig;
    /** Injected so tests can run without touching the network. */
    verifyAccount?: (accountId: string) => Promise<boolean>;
}

export const createApp = ({ store, config, verifyAccount }: AppDeps): Hono => {
    const app = new Hono();
    const checkAccount =
        verifyAccount ?? ((id: string) => accountExists(config.mirrorNodeUrl, id));

    app.use("*", cors());

    app.onError((err, c) => {
        console.error(err);
        return c.json({ error: "Internal server error" }, 500);
    });

    app.get("/health", (c) => c.json({ ok: true, network: config.hederaNetwork }));

    // ── discovery (free) ─────────────────────────────────────────────────────
    // This is the surface a buying agent reads to decide who to hire, so it
    // stays unpaywalled: you shouldn't have to pay to find out what's for sale.

    app.get("/registry", (c) => c.json({ listings: store.list() }));

    // Registered before /registry/:slug so "search" isn't captured as a slug.
    app.get("/registry/search", (c) => {
        const q = c.req.query("q");
        const tag = c.req.query("tag");
        return c.json({ listings: store.search(q, tag) });
    });

    app.get("/registry/:slug", (c) => {
        const listing = store.get(c.req.param("slug"));
        if (!listing) return c.json({ error: "Unknown agent" }, 404);
        return c.json({
            listing,
            payToUrl: hashscanAccount(listing.payToAccount),
        });
    });

    // ── listing (free) ───────────────────────────────────────────────────────

    app.post("/registry", async (c) => {
        let draft: ListingDraft;
        try {
            draft = (await c.req.json()) as ListingDraft;
        } catch {
            return c.json({ error: "Body must be JSON" }, 400);
        }

        const errors = validateDraft(draft);
        if (errors.length > 0) return c.json({ error: "Invalid listing", errors }, 400);

        const slug = draft.slug ?? slugify(draft.name);
        if (store.get(slug)) {
            return c.json(
                { error: "Invalid listing", errors: [{ field: "slug", message: `Slug '${slug}' is taken` }] },
                409,
            );
        }

        // A payee that doesn't exist on-network fails at settlement time, long
        // after listing — catch it here where the error is actionable.
        if (!(await checkAccount(draft.payToAccount))) {
            return c.json(
                {
                    error: "Invalid listing",
                    errors: [
                        {
                            field: "payToAccount",
                            message: `Account ${draft.payToAccount} was not found on ${config.hederaNetwork}`,
                        },
                    ],
                },
                400,
            );
        }

        const listing = draftToListing({ ...draft, slug });
        const ownerToken = newOwnerToken();
        store.insert(listing, ownerToken);

        return c.json(
            {
                listing: { ...listing, calls: 0, earnedTinybar: 0 },
                // Shown exactly once — it's the only way to edit the listing later.
                ownerToken,
                hireUrl: `${new URL(c.req.url).origin}/a/${listing.slug}`,
                payToUrl: hashscanAccount(listing.payToAccount),
            },
            201,
        );
    });

    app.patch("/registry/:slug", async (c) => {
        const slug = c.req.param("slug");
        const existing = store.get(slug);
        if (!existing) return c.json({ error: "Unknown agent" }, 404);

        const token = c.req.header("x-owner-token");
        if (!token || token !== store.ownerTokenFor(slug)) {
            return c.json({ error: "Invalid or missing owner token" }, 403);
        }

        let patch: Partial<ListingDraft>;
        try {
            patch = (await c.req.json()) as Partial<ListingDraft>;
        } catch {
            return c.json({ error: "Body must be JSON" }, 400);
        }

        // Validate the merged result so a patch can't sneak past field rules.
        const merged = { ...existing, ...patch, slug };
        const errors = validateDraft(merged as ListingDraft);
        if (errors.length > 0) return c.json({ error: "Invalid listing", errors }, 400);

        if (patch.payToAccount && patch.payToAccount !== existing.payToAccount) {
            if (!(await checkAccount(patch.payToAccount))) {
                return c.json(
                    {
                        error: "Invalid listing",
                        errors: [
                            { field: "payToAccount", message: `Account ${patch.payToAccount} was not found` },
                        ],
                    },
                    400,
                );
            }
        }

        store.update(slug, patch as never);
        return c.json({ listing: store.get(slug) });
    });

    // ── activity (free) ──────────────────────────────────────────────────────
    // Every row is one settled payment, linked to its proof on HashScan.

    app.get("/activity", (c) => {
        const limit = Math.min(Number(c.req.query("limit") ?? "50"), 200);
        const calls = store.recentCalls(limit).map((call) => {
            const listing = store.get(call.slug);
            return {
                ...call,
                agentName: listing?.name ?? call.slug,
                payTo: listing?.payToAccount,
                txUrl: hashscanTx(call.txId),
                payerUrl: hashscanAccount(call.payer),
                payToUrl: listing ? hashscanAccount(listing.payToAccount) : undefined,
            };
        });
        return c.json({ calls });
    });

    return app;
};
