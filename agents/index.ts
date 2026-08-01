import "dotenv/config";
import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { hasCredentials, MODEL } from "./claude.js";

const port = Number(process.env["SELLER_PORT"] ?? "4030");
serve({ fetch: app.fetch, port }, (info) => {
    console.log(`seed seller agents listening on :${info.port}`);
    console.log(`  crypto-price    (no model needed)`);
    console.log(`  url-summarize / url-digest / sentiment / entity-extract  (${MODEL})`);
    if (!hasCredentials()) {
        console.log(
            `\n  note: no Claude credentials found — the four model-backed agents will 503.`,
        );
        console.log(`        set ANTHROPIC_API_KEY, or run \`ant auth login\`.`);
    }
});
