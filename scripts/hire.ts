// The buying agent, on the command line.
//
//   npm run hire -- "how does this article feel about hedera: https://…"
//
// Claude reads the marketplace registry and returns a *plan*: which agents to
// hire, in what order, with what inputs. It never gets a payment tool — the
// engine executes the payments itself. That keeps the budget cap enforceable
// rather than advisory, and keeps the signing key out of any tool-calling loop.
//
// Shares its engine with the chat service in `buyer/` — see src/core/buyer.ts.
import "dotenv/config";
import { PlanSchema, runTask, type BuyerConfig, type Listing } from "../src/core/buyer.js";
import { formatHbar } from "../src/core/hashscan.js";

const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var: ${name}`);
    return value;
};

const task = process.argv.slice(2).join(" ").trim();
if (!task) {
    console.error('usage: npm run hire -- "your task in plain english"');
    process.exit(1);
}

const config: BuyerConfig = {
    gatewayUrl: process.env["SERVER_URL"] ?? "http://localhost:4021",
    accountId: required("HEDERA_CLIENT_ID"),
    privateKey: required("HEDERA_CLIENT_KEY"),
    network: process.env["HEDERA_NETWORK"] ?? "hedera:testnet",
    maxSpendTinybar: Number(process.env["MAX_SPEND_TINYBAR"] ?? "50000000"),
};

// Escape hatch: supply the plan directly and skip the model. Useful for
// exercising the payment path without credentials, and as a deterministic
// fallback if the API is unreachable mid-demo.
const injected = process.env["HIRE_PLAN"];
const plan = injected ? PlanSchema.parse(JSON.parse(injected)) : undefined;

const bar = "─".repeat(64);
let listings: Listing[] = [];
let exitCode = 0;

console.log(`\ntask     ${task}`);
console.log(`budget   ${formatHbar(config.maxSpendTinybar)}`);

for await (const event of runTask(task, config, plan)) {
    switch (event.type) {
        case "listings":
            listings = event.listings;
            console.log(`registry ${listings.length} agents at ${config.gatewayUrl}\n`);
            break;

        case "thinking":
            console.log("choosing which agents to hire…\n");
            break;

        case "plan": {
            const bySlug = new Map(listings.map((l) => [l.slug, l]));
            console.log(bar);
            console.log(`plan     ${event.plan.reasoning}`);
            console.log(bar);
            event.plan.steps.forEach((step, i) => {
                const listing = bySlug.get(step.slug);
                const chained =
                    step.usesOutputOf !== null ? `  ← output of step ${step.usesOutputOf + 1}` : "";
                console.log(
                    `  ${i + 1}. ${listing?.name ?? step.slug} (${step.slug})  ${formatHbar(listing?.priceTinybar ?? 0)}${chained}`,
                );
                console.log(`     ${step.reason}`);
            });
            console.log(bar);
            console.log(
                `projected ${formatHbar(event.projectedTinybar)} across ${event.plan.steps.length} agent(s)  ·  budget ${formatHbar(event.budgetTinybar)}`,
            );
            break;
        }

        case "refused":
            console.log(bar);
            console.error(
                `\nREFUSED: this plan would cost ${formatHbar(event.projectedTinybar)}, over the ${formatHbar(event.budgetTinybar)} budget.`,
            );
            console.error("Nothing was paid. Raise MAX_SPEND_TINYBAR or give a narrower task.");
            console.error("\nSkipped:");
            for (const name of event.skipped) console.error(`  - ${name}`);
            exitCode = 2;
            break;

        case "step-start":
            console.log(bar);
            process.stdout.write(`  [${event.index + 1}] ${event.name} … `);
            break;

        case "step-paid":
            console.log(`paid ${formatHbar(event.priceTinybar)} → ${event.payTo}`);
            console.log(`      ${event.txUrl}`);
            break;

        case "step-failed":
            console.log("failed");
            console.error(`      ${event.message}`);
            console.error("      nothing was charged for this call");
            exitCode = 1;
            break;

        case "done":
            if (event.result !== null && event.result !== undefined) {
                console.log(`\n${bar}`);
                console.log("result\n");
                console.log(
                    typeof event.result === "string"
                        ? event.result
                        : JSON.stringify(event.result, null, 2),
                );
            }
            console.log(`\n${bar}`);
            console.log(
                `spent ${formatHbar(event.spentTinybar)}  ·  budget remaining ${formatHbar(config.maxSpendTinybar - event.spentTinybar)}`,
            );
            break;

        case "error":
            console.error(`\n${event.message}`);
            if (/marketplace/i.test(event.message)) {
                console.error("Is the gateway running?  npm run dev");
            }
            if (/credential|ANTHROPIC/i.test(event.message)) {
                console.error("\nTo pay a specific agent directly without an LLM:");
                console.error(`  npm run e2e -- crypto-price '{"coin":"bitcoin"}'`);
            }
            exitCode = 1;
            break;
    }
}

process.exit(exitCode);
