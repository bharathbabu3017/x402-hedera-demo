import { Hono } from "hono";
import { z } from "zod/v4";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ask, hasCredentials, MODEL, MissingCredentials } from "./claude.js";
import { fetchPageText, PageFetchError } from "./page.js";

/**
 * A third-party seller's service. Five agents, plain HTTP, JSON in and JSON
 * out. There is deliberately not a single x402, Hedera or payment import in
 * this directory — the gateway monetises these endpoints from the outside.
 */

export const app = new Hono();
const client = new Anthropic();

app.get("/", (c) =>
    c.json({
        service: "seed seller agents",
        agents: ["crypto-price", "url-summarize", "url-digest", "sentiment", "entity-extract"],
        llmBacked: hasCredentials(),
    }),
);

const requireField = (body: Record<string, unknown>, field: string): string => {
    const value = body[field];
    if (typeof value !== "string" || value.trim() === "") {
        throw new PageFetchError(`Missing required field: ${field}`);
    }
    return value;
};

// ── crypto-price ─────────────────────────────────────────────────────────────
// The only agent here that needs no model — real market data, no API key.

app.post("/crypto-price", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const coin = requireField(body, "coin").toLowerCase();

    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coin)}&vs_currencies=usd`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return c.json({ error: `CoinGecko returned HTTP ${res.status}` }, 502);

    const data = (await res.json()) as Record<string, { usd?: number }>;
    const usd = data[coin]?.usd;
    if (usd === undefined) {
        return c.json({ error: `Unknown coin id '${coin}'. Try 'bitcoin' or 'ethereum'.` }, 400);
    }

    return c.json({ coin, usd, asOf: new Date().toISOString(), source: "coingecko" });
});

// ── url-summarize / url-digest ───────────────────────────────────────────────
// Deliberately overlapping capability at different prices, so a buying agent
// has a real cost/quality decision to justify.

app.post("/url-summarize", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const url = requireField(body, "url");
    const page = await fetchPageText(url);

    const summary = await ask(
        `Summarise the following web page in three to five paragraphs. Preserve key facts, figures, dates and named entities. Write prose, not bullet points.\n\nTitle: ${page.title}\n\n${page.text}`,
        { effort: "medium" },
    );

    return c.json({ url, title: page.title, summary, words: summary.split(/\s+/).length });
});

app.post("/url-digest", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const url = requireField(body, "url");
    const page = await fetchPageText(url);

    const digest = await ask(
        `In exactly two sentences, say what the following web page is about. No preamble.\n\nTitle: ${page.title}\n\n${page.text.slice(0, 6000)}`,
    );

    return c.json({ url, title: page.title, digest });
});

// ── sentiment ────────────────────────────────────────────────────────────────
// Held back from the seeded registry so it can be listed live during the demo.

const Sentiment = z.object({
    sentiment: z.enum(["positive", "negative", "neutral", "mixed"]),
    confidence: z.number(),
    rationale: z.string(),
});

app.post("/sentiment", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const text = requireField(body, "text");

    const res = await client.messages.parse({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: "low", format: zodOutputFormat(Sentiment) },
        messages: [
            {
                role: "user",
                content: `Classify the overall sentiment of this text. Give a confidence between 0 and 1 and a one-sentence rationale.\n\n${text}`,
            },
        ],
    });

    return c.json({ ...res.parsed_output, characters: text.length });
});

// ── entity-extract ───────────────────────────────────────────────────────────

const Entities = z.object({
    people: z.array(z.string()),
    organizations: z.array(z.string()),
    locations: z.array(z.string()),
    dates: z.array(z.string()),
    amounts: z.array(z.string()),
});

app.post("/entity-extract", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const text = requireField(body, "text");

    const res = await client.messages.parse({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: "low", format: zodOutputFormat(Entities) },
        messages: [
            {
                role: "user",
                content: `Extract named entities from this text. Return empty arrays for categories with no matches; do not invent entries.\n\n${text}`,
            },
        ],
    });

    return c.json(res.parsed_output);
});

app.onError((err, c) => {
    if (err instanceof PageFetchError) return c.json({ error: err.message }, 400);
    if (err instanceof MissingCredentials) return c.json({ error: err.message }, 503);

    // An unset key surfaces from the SDK, not from our own guard.
    if (err instanceof Anthropic.AuthenticationError || !hasCredentials()) {
        return c.json({ error: new MissingCredentials().message }, 503);
    }

    console.error(err);
    return c.json({ error: "Agent failed", detail: err.message }, 500);
});
