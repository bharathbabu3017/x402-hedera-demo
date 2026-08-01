// The buying agent.
//
//   npm run hire -- "how does this article feel about hedera: https://…"
//
// Claude reads the marketplace registry and returns a *plan*: which agents to
// hire, in what order, with what inputs. It never gets a payment tool — this
// script executes the payments itself. That keeps the budget cap enforceable
// rather than advisory, and keeps the signing key out of any tool-calling loop.
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { formatHbar, hashscanTx } from "../src/core/hashscan.js";
import {
    buildInput,
    PlanError,
    projectedCost,
    unknownSlugs,
    type PricedListing,
} from "../src/core/plan.js";

const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var: ${name}`);
    return value;
};

const GATEWAY = process.env["SERVER_URL"] ?? "http://localhost:4021";
const MAX_SPEND = Number(process.env["MAX_SPEND_TINYBAR"] ?? "50000000");

const task = process.argv.slice(2).join(" ").trim();
if (!task) {
    console.error('usage: npm run hire -- "your task in plain english"');
    process.exit(1);
}

// ── the plan Claude must return ──────────────────────────────────────────────
// `input` is name/value pairs rather than a map: structured outputs reject any
// object whose `additionalProperties` isn't false, which rules out z.record().

const Plan = z.object({
    reasoning: z.string().describe("One or two sentences on the overall approach."),
    steps: z
        .array(
            z.object({
                slug: z.string().describe("The slug of the agent to hire."),
                reason: z
                    .string()
                    .describe(
                        "Why this agent over the alternatives. If two agents overlap, say why this price/quality tradeoff is right.",
                    ),
                input: z.array(z.object({ name: z.string(), value: z.string() })),
                usesOutputOf: z
                    .number()
                    .nullable()
                    .describe("Zero-based index of an earlier step whose output feeds this one, else null."),
                outputIntoField: z
                    .string()
                    .nullable()
                    .describe("Which input field receives that earlier output, else null."),
            }),
        )
        .describe("Ordered steps. Use multiple steps when one agent's output should feed another."),
});

type PlanType = z.infer<typeof Plan>;

interface Listing {
    slug: string;
    name: string;
    description: string;
    tags: string[];
    priceTinybar: number;
    payToAccount: string;
    inputSchema: Record<string, { type: string; required: boolean; description: string }>;
}

const bar = "─".repeat(64);

// ── 1. read the registry ─────────────────────────────────────────────────────

// A refused connection throws rather than returning a non-ok response, so both
// paths need handling to avoid a raw stack trace on the most common mistake.
let listings: Listing[];
try {
    const registryRes = await fetch(`${GATEWAY}/registry`);
    if (!registryRes.ok) throw new Error(`HTTP ${registryRes.status}`);
    ({ listings } = (await registryRes.json()) as { listings: Listing[] });
} catch (err) {
    console.error(`Could not reach the marketplace at ${GATEWAY} (${(err as Error).message}).`);
    console.error("Is the gateway running?  npm run dev");
    process.exit(1);
}

if (listings.length === 0) {
    console.error("The marketplace has no agents listed yet.");
    process.exit(1);
}

console.log(`\ntask     ${task}`);
console.log(`registry ${listings.length} agents available at ${GATEWAY}`);
console.log(`budget   ${formatHbar(MAX_SPEND)}\n`);

// ── 2. ask Claude which agents to hire ───────────────────────────────────────

const catalogue = listings
    .map((l) => {
        const fields = Object.entries(l.inputSchema)
            .map(([name, spec]) => `${name} (${spec.type}${spec.required ? ", required" : ""}): ${spec.description}`)
            .join("; ");
        return [
            `- slug: ${l.slug}`,
            `  name: ${l.name}`,
            `  price: ${l.priceTinybar} tinybar (${formatHbar(l.priceTinybar)})`,
            `  does: ${l.description}`,
            `  inputs: ${fields || "none"}`,
        ].join("\n");
    })
    .join("\n");

const client = new Anthropic();

let plan: PlanType;

// Escape hatch: supply the plan directly and skip the model. Useful for
// exercising the payment path without credentials, and as a deterministic
// fallback if the API is unreachable mid-demo.
const injected = process.env["HIRE_PLAN"];
if (injected) {
    plan = Plan.parse(JSON.parse(injected));
    console.log("(plan supplied via HIRE_PLAN — the model was not consulted)\n");
} else
try {
    const res = await client.messages.parse({
        model: "claude-opus-5",
        max_tokens: 16000,
        // Choosing between overlapping agents on price and capability is the
        // whole job here — worth the default effort rather than rushing it.
        output_config: { format: zodOutputFormat(Plan) },
        messages: [
            {
                role: "user",
                content: `You are a buying agent with a budget. Choose which agents from this marketplace to hire to complete the task, and in what order.

Marketplace:
${catalogue}

Task: ${task}

Rules:
- Only use slugs that appear above.
- Hire the fewest agents that genuinely complete the task; every hire costs real money.
- When two agents overlap in capability, pick on price unless the task needs the more thorough one, and justify the choice.
- If one agent's output should feed another, order the steps and set usesOutputOf and outputIntoField.
- Fill every required input field. For a field fed by an earlier step, put a placeholder in the value and set outputIntoField to that field's name.`,
            },
        ],
    });
    if (!res.parsed_output) throw new Error("Claude returned no usable plan");
    plan = res.parsed_output;
} catch (err) {
    const message = (err as Error).message;
    if (err instanceof Anthropic.AuthenticationError || /api.?key|credential/i.test(message)) {
        console.error("The buying agent needs Claude credentials to choose who to hire.");
        console.error("Set ANTHROPIC_API_KEY (console.anthropic.com) or run `ant auth login`.");
        console.error("\nTo pay a specific agent directly without an LLM:");
        console.error(`  npm run e2e -- crypto-price '{"coin":"bitcoin"}'`);
        process.exit(1);
    }
    throw err;
}

// ── 3. show the plan and its cost BEFORE any money moves ─────────────────────

const bySlug = new Map(listings.map((l) => [l.slug, l]));
const unknown = unknownSlugs(plan.steps, bySlug as Map<string, PricedListing>);
if (unknown.length > 0) {
    console.error(`Claude picked agents that aren't listed: ${unknown.join(", ")}`);
    process.exit(1);
}

const projected = projectedCost(plan.steps, bySlug as Map<string, PricedListing>);

console.log(bar);
console.log(`plan     ${plan.reasoning}`);
console.log(bar);
plan.steps.forEach((step, i) => {
    const listing = bySlug.get(step.slug)!;
    const chained = step.usesOutputOf !== null ? `  ← output of step ${step.usesOutputOf + 1}` : "";
    console.log(`  ${i + 1}. ${listing.name} (${step.slug})  ${formatHbar(listing.priceTinybar)}${chained}`);
    console.log(`     ${step.reason}`);
});
console.log(bar);
console.log(`projected ${formatHbar(projected)} across ${plan.steps.length} agent(s)  ·  budget ${formatHbar(MAX_SPEND)}`);

// ── 4. budget guard — enforced in code, before the first payment ─────────────

if (projected > MAX_SPEND) {
    console.log(bar);
    console.error(`\nREFUSED: this plan would cost ${formatHbar(projected)}, over the ${formatHbar(MAX_SPEND)} budget.`);
    console.error("Nothing was paid. Raise MAX_SPEND_TINYBAR or give a narrower task.");
    console.error("\nSkipped:");
    for (const step of plan.steps) {
        const listing = bySlug.get(step.slug)!;
        console.error(`  - ${listing.name} (${formatHbar(listing.priceTinybar)})`);
    }
    process.exit(2);
}

// ── 5. execute, paying per call ──────────────────────────────────────────────

const signer = createClientHederaSigner(
    required("HEDERA_CLIENT_ID"),
    PrivateKey.fromStringECDSA(required("HEDERA_CLIENT_KEY")),
    { network: process.env["HEDERA_NETWORK"] ?? "hedera:testnet" },
);
const x402 = new x402Client().register("hedera:*", new ExactHederaScheme(signer));
const pay = wrapFetchWithPayment(fetch, x402);
const httpClient = new x402HTTPClient(x402);

console.log(bar);
console.log("executing\n");

const outputs: unknown[] = [];
let spent = 0;

for (const [i, step] of plan.steps.entries()) {
    const listing = bySlug.get(step.slug)!;

    let input: Record<string, unknown>;
    try {
        input = buildInput(step, listing, outputs);
    } catch (err) {
        if (err instanceof PlanError) {
            console.error(`  step ${i + 1}: ${err.message}`);
            process.exit(1);
        }
        throw err;
    }

    process.stdout.write(`  [${i + 1}/${plan.steps.length}] ${listing.name} … `);

    const res = await pay(`${GATEWAY}/a/${step.slug}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
    });

    if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { error?: string };
        console.log(`failed (HTTP ${res.status})`);
        console.error(`      ${detail.error ?? "no detail"}`);
        console.error(`      nothing was charged for this call`);
        break;
    }

    const body = (await res.json()) as { result: unknown };
    outputs.push(body.result);

    let settlement;
    try {
        settlement = httpClient.getPaymentSettleResponse((n) => res.headers.get(n));
    } catch {
        settlement = undefined;
    }

    if (settlement?.success && settlement.transaction) {
        spent += listing.priceTinybar;
        console.log(`paid ${formatHbar(listing.priceTinybar)} → ${listing.payToAccount}`);
        console.log(`      ${hashscanTx(settlement.transaction)}`);
    } else {
        console.log("served (no payment required)");
    }
}

// ── 6. result ────────────────────────────────────────────────────────────────

const final = outputs.at(-1);
if (final !== undefined) {
    console.log(`\n${bar}`);
    console.log("result\n");
    console.log(typeof final === "string" ? final : JSON.stringify(final, null, 2));
}

console.log(`\n${bar}`);
console.log(`spent ${formatHbar(spent)} across ${outputs.length} agent(s)  ·  budget remaining ${formatHbar(MAX_SPEND - spent)}`);
