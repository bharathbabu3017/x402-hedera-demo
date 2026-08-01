import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import { getBalanceTinybar, runTask, PlanSchema, type BuyerConfig } from "../src/core/buyer.js";
import { hashscanAccount } from "../src/core/hashscan.js";

/**
 * The buying agent as a service, so the chat UI can hire agents from a browser.
 *
 * This is the one process that holds a Hedera key — read straight from `.env`,
 * which is fine for a localhost demo and deliberately kept out of the
 * marketplace gateway, so "the marketplace never holds a key" stays true.
 */

const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var: ${name}`);
    return value;
};

const config: BuyerConfig = {
    gatewayUrl: process.env["SERVER_URL"] ?? "http://localhost:4021",
    accountId: required("HEDERA_CLIENT_ID"),
    privateKey: required("HEDERA_CLIENT_KEY"),
    network: process.env["HEDERA_NETWORK"] ?? "hedera:testnet",
    maxSpendTinybar: Number(process.env["MAX_SPEND_TINYBAR"] ?? "50000000"),
};

const mirrorNodeUrl = process.env["MIRROR_NODE_URL"] ?? "https://testnet.mirrornode.hedera.com";

const app = new Hono();
app.use("*", cors());

app.get("/wallet", async (c) => {
    const balanceTinybar = await getBalanceTinybar(mirrorNodeUrl, config.accountId);
    return c.json({
        accountId: config.accountId,
        accountUrl: hashscanAccount(config.accountId),
        balanceTinybar,
        budgetTinybar: config.maxSpendTinybar,
        network: config.network,
        gatewayUrl: config.gatewayUrl,
    });
});

/**
 * Streams the buy as it happens — plan, then each payment — so the UI can show
 * progress rather than a spinner followed by a wall of text.
 */
app.post("/chat", async (c) => {
    let body: { task?: string; plan?: unknown };
    try {
        body = await c.req.json();
    } catch {
        return c.json({ error: "Body must be JSON" }, 400);
    }

    const task = (body.task ?? "").trim();
    if (!task) return c.json({ error: "A task is required" }, 400);

    // Same escape hatch as the CLI: supply a plan and skip the model. Useful
    // when the API is unreachable mid-demo.
    const injected = body.plan ? PlanSchema.parse(body.plan) : undefined;

    return streamSSE(c, async (stream) => {
        try {
            for await (const event of runTask(task, config, injected)) {
                await stream.writeSSE({ data: JSON.stringify(event) });
            }
        } catch (err) {
            await stream.writeSSE({
                data: JSON.stringify({ type: "error", message: (err as Error).message }),
            });
        }
        // Lets the browser close the EventSource cleanly instead of retrying.
        await stream.writeSSE({ data: JSON.stringify({ type: "close" }) });
    });
});

app.get("/health", (c) => c.json({ ok: true, accountId: config.accountId }));

const port = Number(process.env["BUYER_PORT"] ?? "4040");
serve({ fetch: app.fetch, port }, (info) => {
    console.log(`buying agent listening on :${info.port}`);
    console.log(`  wallet   ${config.accountId} (key from .env — demo only)`);
    console.log(`  budget   ${config.maxSpendTinybar / 1e8} ℏ per task`);
    console.log(`  market   ${config.gatewayUrl}`);
});
