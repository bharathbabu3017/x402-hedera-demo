import "dotenv/config";
import { serve } from "@hono/node-server";
import { loadConfig } from "../core/config.js";
import { MarketplaceStore } from "../core/store.js";
import { seedIfEmpty } from "../core/seed.js";
import { createApp } from "./app.js";

const config = loadConfig();
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
