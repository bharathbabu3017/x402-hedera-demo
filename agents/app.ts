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

/**
 * What this seller offers, in a shape the marketplace's listing form can take
 * directly. `POST /registry` on the gateway accepts these almost verbatim —
 * which is the point: a seller shouldn't have to hand-translate their own
 * catalogue into someone else's schema.
 */
export interface AgentOffer {
    slug: string;
    path: string;
    name: string;
    description: string;
    tags: string[];
    suggestedPriceTinybar: number;
    inputSchema: Record<string, { type: "string" | "number"; required: boolean; description: string }>;
    outputExample: unknown;
    needsModel: boolean;
}

export const catalogue: AgentOffer[] = [
    {
        slug: "crypto-price",
        path: "/crypto-price",
        name: "Crypto Spot Price",
        description:
            "Returns the current USD spot price for a cryptocurrency by CoinGecko id, e.g. bitcoin or ethereum. Live market data, no API key required.",
        tags: ["crypto", "market-data", "price"],
        suggestedPriceTinybar: 1_000_000,
        inputSchema: {
            coin: { type: "string", required: true, description: "CoinGecko coin id, e.g. 'bitcoin'" },
        },
        outputExample: { coin: "bitcoin", usd: 94231.5, asOf: "2026-08-01T00:00:00.000Z" },
        needsModel: false,
    },
    {
        slug: "url-summarize",
        path: "/url-summarize",
        name: "Web Page Summarizer",
        description:
            "Fetches a web page and returns a thorough multi-paragraph summary of its content, preserving key facts, figures and named entities. Best when you need detail.",
        tags: ["web", "summarization", "research"],
        suggestedPriceTinybar: 5_000_000,
        inputSchema: {
            url: { type: "string", required: true, description: "Public http(s) URL to summarize" },
        },
        outputExample: { url: "https://example.com", summary: "…", words: 180 },
        needsModel: true,
    },
    {
        slug: "url-digest",
        path: "/url-digest",
        name: "Web Page Digest",
        description:
            "Fetches a web page and returns a short two-sentence digest of what it is about. Cheaper and faster than a full summary; use when a brief gist is enough.",
        tags: ["web", "summarization"],
        suggestedPriceTinybar: 2_000_000,
        inputSchema: {
            url: { type: "string", required: true, description: "Public http(s) URL to digest" },
        },
        outputExample: { url: "https://example.com", digest: "…" },
        needsModel: true,
    },
    {
        slug: "entity-extract",
        path: "/entity-extract",
        name: "Entity Extractor",
        description:
            "Extracts named entities from a block of text — people, organizations, locations, dates and monetary amounts — and returns them grouped by type.",
        tags: ["nlp", "extraction", "text"],
        suggestedPriceTinybar: 3_000_000,
        inputSchema: {
            text: { type: "string", required: true, description: "Text to extract entities from" },
        },
        outputExample: { people: ["Ada Lovelace"], organizations: [], locations: ["London"] },
        needsModel: true,
    },
    // ── deliberately not in the marketplace seed ─────────────────────────────
    // These run here but stay unlisted, so a seller can be shown listing a
    // brand-new agent live and having it hired moments later.
    {
        slug: "sentiment",
        path: "/sentiment",
        name: "Sentiment Classifier",
        description:
            "Classifies the sentiment of a block of text as positive, negative, neutral or mixed, with a confidence score and a one-sentence rationale.",
        tags: ["nlp", "sentiment"],
        suggestedPriceTinybar: 2_000_000,
        inputSchema: { text: { type: "string", required: true, description: "Text to classify" } },
        outputExample: { sentiment: "positive", confidence: 0.92, rationale: "…" },
        needsModel: true,
    },
    {
        slug: "translate",
        path: "/translate",
        name: "Translator",
        description:
            "Translates a block of text into a target language, preserving tone and formatting. Give the language in plain English, e.g. 'Spanish' or 'Japanese'.",
        tags: ["nlp", "translation", "text"],
        suggestedPriceTinybar: 3_000_000,
        inputSchema: {
            text: { type: "string", required: true, description: "Text to translate" },
            language: { type: "string", required: true, description: "Target language, e.g. 'Spanish'" },
        },
        outputExample: { language: "Spanish", translation: "Hola, ¿cómo estás?" },
        needsModel: true,
    },
];

app.get("/", (c) =>
    c.json({
        service: "seed seller agents",
        agents: catalogue.map((a) => a.slug),
        llmBacked: hasCredentials(),
    }),
);

/** Listing-ready drafts, so the marketplace's form can offer one-click fill. */
app.get("/catalogue", (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json({
        agents: catalogue.map((a) => ({ ...a, upstreamUrl: `${origin}${a.path}` })),
    });
});

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

// ── translate ────────────────────────────────────────────────────────────────
// Also held back from the seed, as a second option for the live-listing demo.

app.post("/translate", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const text = requireField(body, "text");
    const language = requireField(body, "language");

    const translation = await ask(
        `Translate the following text into ${language}. Preserve tone and formatting. Return only the translation, with no preamble or explanation.\n\n${text}`,
    );

    return c.json({ language, translation, sourceCharacters: text.length });
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
