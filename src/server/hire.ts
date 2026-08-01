import type { Context, MiddlewareHandler } from "hono";
import { decodePaymentResponseHeader } from "@x402/core/http";
import type { MarketplaceStore } from "../core/store.js";
import { slugFromPath, validateInput } from "../core/listing.js";

/** How long a seller's endpoint has to answer before we call it a failure. */
const UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * Rejects bad requests *before* the paywall runs. Without this a buyer is
 * charged for a typo'd slug or a malformed body — and since the money goes to
 * a third party, that isn't something we can quietly refund.
 */
export const preValidateHire =
    (store: MarketplaceStore): MiddlewareHandler =>
    async (c, next) => {
        const slug = c.req.param("slug") ?? slugFromPath(c.req.path);
        const listing = store.get(slug);
        if (!listing) return c.json({ error: `Unknown agent: ${slug}` }, 404);

        let body: Record<string, unknown>;
        try {
            body = (await c.req.raw.clone().json()) as Record<string, unknown>;
        } catch {
            return c.json({ error: "Body must be JSON" }, 400);
        }

        const errors = validateInput(listing, body);
        if (errors.length > 0) return c.json({ error: "Invalid input", errors }, 400);

        await next();
    };

/**
 * Wraps the payment middleware so we can read the settlement it writes and
 * append it to the ledger. Registered *before* paymentMiddleware, so its
 * `await next()` returns once payment has settled and the header is set.
 */
export const recordSettlement =
    (store: MarketplaceStore): MiddlewareHandler =>
    async (c, next) => {
        await next();

        const header = c.res.headers.get("payment-response");
        if (!header) return;

        try {
            const settlement = decodePaymentResponseHeader(header);
            if (!settlement.success) return;

            const slug = c.req.param("slug") ?? slugFromPath(c.req.path);
            const listing = store.get(slug);
            if (!listing) return;

            store.recordCall({
                slug,
                tinybar: listing.priceTinybar,
                txId: settlement.transaction ?? "",
                payer: settlement.payer ?? "",
            });
        } catch (err) {
            // A ledger write must never break a paid response the buyer has
            // already earned.
            console.error("failed to record settlement", err);
        }
    };

/**
 * The paid handler. Calls the seller's upstream first and only returns 2xx if
 * the agent actually delivered — a buyer must not pay for an endpoint that
 * errored.
 */
export const hireHandler =
    (store: MarketplaceStore) =>
    async (c: Context): Promise<Response> => {
        const slug = c.req.param("slug") ?? slugFromPath(c.req.path);
        const listing = store.get(slug);
        if (!listing) return c.json({ error: `Unknown agent: ${slug}` }, 404);

        const body = (await c.req.raw.clone().json()) as Record<string, unknown>;

        let upstream: Response;
        try {
            upstream = await fetch(listing.upstreamUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
            });
        } catch (err) {
            const reason = (err as Error).name === "TimeoutError" ? "timed out" : "was unreachable";
            return c.json(
                { error: `Agent '${slug}' ${reason}`, agent: listing.name, upstreamStatus: null },
                502,
            );
        }

        if (!upstream.ok) {
            return c.json(
                {
                    error: `Agent '${slug}' returned ${upstream.status}`,
                    agent: listing.name,
                    upstreamStatus: upstream.status,
                },
                502,
            );
        }

        let result: unknown;
        try {
            result = await upstream.json();
        } catch {
            return c.json(
                { error: `Agent '${slug}' returned a non-JSON body`, agent: listing.name },
                502,
            );
        }

        return c.json({
            agent: { slug: listing.slug, name: listing.name },
            priceTinybar: listing.priceTinybar,
            result,
            servedAt: new Date().toISOString(),
        });
    };
