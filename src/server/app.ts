import { Hono } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware } from "@x402/hono";
import { x402ResourceServer } from "@x402/core/server";
import type { RoutesConfig } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import type { ServerConfig } from "../core/config.js";
import type { MarketplaceStore } from "../core/store.js";
import {
    draftToListing,
    newOwnerToken,
    priceFor,
    slugFromPath,
    slugify,
    validateDraft,
    type ListingDraft,
} from "../core/listing.js";
import { accountExists } from "../core/mirror.js";
import { buildFacilitator } from "../core/facilitator.js";
import { hashscanAccount, hashscanTx } from "../core/hashscan.js";
import { hireHandler, preValidateHire, recordSettlement } from "./hire.js";

/**
 * Loads the facilitator's supported payment kinds, retrying a few times before
 * giving up. Never throws: a marketplace that can't take payments right now
 * should still let people browse and list agents.
 */
const warmUpFacilitator = async (
    x402: x402ResourceServer,
    facilitatorUrl: string,
    attempts = 4,
): Promise<void> => {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            await x402.initialize();
            return;
        } catch (err) {
            const last = attempt === attempts;
            console.warn(
                `facilitator ${facilitatorUrl} unreachable (attempt ${attempt}/${attempts})${last ? "" : " — retrying"}: ${(err as Error).message}`,
            );
            if (last) {
                console.warn(
                    "  paid hires will fail until it recovers; the registry and web UI keep working.",
                );
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
        }
    }
};

export interface AppDeps {
    store: MarketplaceStore;
    config: ServerConfig;
    /** Injected so tests can run without touching the network. */
    verifyAccount?: (accountId: string) => Promise<boolean>;
    /** Off in unit tests, which assert routing and validation, not settlement. */
    enablePayments?: boolean;
}

export const createApp = ({
    store,
    config,
    verifyAccount,
    enablePayments = true,
}: AppDeps): Hono => {
    const app = new Hono();
    const checkAccount =
        verifyAccount ?? ((id: string) => accountExists(config.mirrorNodeUrl, id));

    app.use("*", cors());

    app.onError((err, c) => {
        // Distinguish "the payment rail is down" from a genuine bug, so a buyer
        // sees something actionable instead of a bare 500.
        if (/no supported payment kinds loaded|facilitator/i.test(err.message)) {
            return c.json(
                {
                    error: "Payments are temporarily unavailable — the x402 facilitator is unreachable.",
                    facilitator: config.facilitatorUrl,
                    hint: "Browsing and listing still work. Retry the hire shortly.",
                },
                503,
            );
        }
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

    // ── hiring (paid) ────────────────────────────────────────────────────────
    //
    // Ordering is load-bearing:
    //   1. pre-validation  — 404/400 before any money moves
    //   2. recorder        — wraps the paywall so it can read the settlement
    //   3. paymentMiddleware
    //   4. handler         — calls upstream, 502s if the agent didn't deliver

    app.use("/a/:slug", preValidateHire(store));

    if (enablePayments) {
        const x402 = new x402ResourceServer(buildFacilitator(config.facilitatorUrl)).register(
            "hedera:*",
            new ExactHederaScheme(),
        );

        // The facilitator is a third-party service and its DNS has been seen to
        // fail intermittently. Left alone, that failure surfaces as an unhandled
        // rejection during middleware init and takes the whole process down —
        // so browsing the marketplace would break because *payments* were down.
        // Warm it up ourselves, with retries, and keep serving either way.
        void warmUpFacilitator(x402, config.facilitatorUrl);

        // Both price and payee are resolved per request from the listing, so a
        // single route serves every agent and pays each seller directly. The
        // marketplace is a router, never an escrow.
        const routes: RoutesConfig = {
            "POST /a/:slug": {
                description: "Hire a marketplace agent — price and payee vary by listing",
                accepts: {
                    scheme: "exact",
                    network: config.hederaNetwork as Network,
                    payTo: (ctx) => {
                        const listing = store.get(slugFromPath(ctx.path));
                        if (!listing) throw new Error(`Unknown agent: ${ctx.path}`);
                        return listing.payToAccount;
                    },
                    price: (ctx) => {
                        const listing = store.get(slugFromPath(ctx.path));
                        if (!listing) throw new Error(`Unknown agent: ${ctx.path}`);
                        return priceFor(listing);
                    },
                    maxTimeoutSeconds: 180,
                },
            },
        };

        app.use("/a/:slug", recordSettlement(store));
        app.use("/a/:slug", paymentMiddleware(routes, x402));
    }

    app.post("/a/:slug", hireHandler(store));

    return app;
};
