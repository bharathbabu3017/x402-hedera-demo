import "dotenv/config";
import { serve } from "@hono/node-server";
import { loadConfig } from "../core/config.js";
import { MarketplaceStore } from "../core/store.js";
import { seedIfEmpty } from "../core/seed.js";
import { createApp } from "./app.js";

const config = loadConfig();

/**
 * `paymentMiddleware` initialises the facilitator connection itself, and if the
 * facilitator is unreachable that rejection is unhandled and kills the process.
 * The facilitator is a third party whose DNS has been seen to fail
 * intermittently, and a marketplace that can't take payments *right now* should
 * still let people browse, list agents and read the activity feed.
 *
 * Narrow on purpose: only this one failure is swallowed; anything else still
 * crashes loudly, as it should.
 */
let facilitatorWarned = false;
process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    if (/no supported payment kinds loaded/i.test(message)) {
        if (!facilitatorWarned) {
            facilitatorWarned = true;
            console.warn(
                `\n  facilitator ${config.facilitatorUrl} is unreachable.` +
                    `\n  Paid hires will fail until it recovers; the registry and web UI keep working.\n`,
            );
        }
        return;
    }
    throw reason;
});

const store = new MarketplaceStore(config.databasePath);

const seeded = seedIfEmpty(store, config);
if (seeded > 0) console.log(`seeded ${seeded} listing(s)`);

const app = createApp({ store, config });

serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`agent marketplace gateway listening on :${info.port}`);
    console.log(`  registry  http://localhost:${info.port}/registry`);
    console.log(`  activity  http://localhost:${info.port}/activity`);
    console.log(`  network   ${config.hederaNetwork}`);
});
