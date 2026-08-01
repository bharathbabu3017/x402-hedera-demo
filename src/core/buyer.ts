// The buying agent's engine, shared by the CLI (`npm run hire`) and the chat
// service. Emits events as it goes so both surfaces can show the plan, the cost
// and each settled payment as they happen — rather than only at the end.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod/v4";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { hashscanTx } from "./hashscan.js";
import { buildInput, PlanError, projectedCost, unknownSlugs, type PricedListing } from "./plan.js";

export const PLANNER_MODEL = "claude-opus-5";

/**
 * `input` is name/value pairs rather than a map: structured outputs reject any
 * object whose `additionalProperties` isn't false, which rules out z.record().
 */
export const PlanSchema = z.object({
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

export type Plan = z.infer<typeof PlanSchema>;

export interface Listing extends PricedListing {
    name: string;
    description: string;
    tags: string[];
    payToAccount: string;
}

export interface BuyerConfig {
    gatewayUrl: string;
    accountId: string;
    privateKey: string;
    network: string;
    maxSpendTinybar: number;
}

/** The protocol exchange behind one hire, surfaced so the UI can show it. */
export interface Exchange {
    /** The decoded `payment-required` challenge the gateway answered 402 with. */
    challenge?: unknown;
}

export type BuyerEvent =
    | { type: "listings"; listings: Listing[] }
    | { type: "thinking" }
    | { type: "plan"; plan: Plan; projectedTinybar: number; budgetTinybar: number }
    | { type: "refused"; projectedTinybar: number; budgetTinybar: number; skipped: string[] }
    | { type: "step-start"; index: number; slug: string; name: string; priceTinybar: number }
    | { type: "step-402"; index: number; slug: string; challenge: unknown }
    | {
          type: "step-paid";
          index: number;
          slug: string;
          priceTinybar: number;
          payTo: string;
          txId: string;
          txUrl: string;
          settlement: unknown;
      }
    | { type: "step-result"; index: number; slug: string; result: unknown }
    | { type: "step-failed"; index: number; slug: string; message: string; charged: false }
    | { type: "done"; spentTinybar: number; result: unknown }
    | { type: "error"; message: string };

export class MissingPlannerCredentials extends Error {
    constructor() {
        super(
            "The buying agent needs Claude credentials to choose who to hire. Set ANTHROPIC_API_KEY, or run `ant auth login`.",
        );
    }
}

export const fetchListings = async (gatewayUrl: string): Promise<Listing[]> => {
    // A refused connection throws rather than returning a status.
    const res = await fetch(`${gatewayUrl}/registry`);
    if (!res.ok) throw new Error(`Marketplace returned HTTP ${res.status}`);
    return ((await res.json()) as { listings: Listing[] }).listings;
};

export const getBalanceTinybar = async (
    mirrorNodeUrl: string,
    accountId: string,
): Promise<number | null> => {
    try {
        const res = await fetch(`${mirrorNodeUrl.replace(/\/$/, "")}/api/v1/accounts/${accountId}`, {
            signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) return null;
        return ((await res.json()) as { balance: { balance: number } }).balance.balance;
    } catch {
        return null;
    }
};

const describeCatalogue = (listings: Listing[]): string =>
    listings
        .map((l) => {
            const fields = Object.entries(l.inputSchema)
                .map(([name, spec]) => `${name} (${spec.type}${spec.required ? ", required" : ""}): ${spec.description}`)
                .join("; ");
            return [
                `- slug: ${l.slug}`,
                `  name: ${l.name}`,
                `  price: ${l.priceTinybar} tinybar`,
                `  does: ${l.description}`,
                `  inputs: ${fields || "none"}`,
            ].join("\n");
        })
        .join("\n");

export const planTask = async (task: string, listings: Listing[]): Promise<Plan> => {
    const client = new Anthropic();
    try {
        const res = await client.messages.parse({
            model: PLANNER_MODEL,
            max_tokens: 16000,
            // Choosing between overlapping agents on price and capability is the
            // whole job — worth the default effort rather than rushing it.
            output_config: { format: zodOutputFormat(PlanSchema) },
            messages: [
                {
                    role: "user",
                    content: `You are a buying agent with a budget. Choose which agents from this marketplace to hire to complete the task, and in what order.

Marketplace:
${describeCatalogue(listings)}

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
        return res.parsed_output;
    } catch (err) {
        const message = (err as Error).message;
        if (err instanceof Anthropic.AuthenticationError || /api.?key|credential/i.test(message)) {
            throw new MissingPlannerCredentials();
        }
        throw err;
    }
};

/**
 * Runs a task end to end. The model produces a plan; this generator executes
 * the payments. Claude never gets a payment tool, so the budget cap below is
 * enforced in code rather than being a suggestion the model might ignore.
 */
export async function* runTask(
    task: string,
    config: BuyerConfig,
    injectedPlan?: Plan,
): AsyncGenerator<BuyerEvent> {
    let listings: Listing[];
    try {
        listings = await fetchListings(config.gatewayUrl);
    } catch (err) {
        yield { type: "error", message: `Can't reach the marketplace: ${(err as Error).message}` };
        return;
    }

    if (listings.length === 0) {
        yield { type: "error", message: "The marketplace has no agents listed yet." };
        return;
    }
    yield { type: "listings", listings };

    let plan: Plan;
    if (injectedPlan) {
        plan = injectedPlan;
    } else {
        yield { type: "thinking" };
        try {
            plan = await planTask(task, listings);
        } catch (err) {
            yield { type: "error", message: (err as Error).message };
            return;
        }
    }

    const bySlug = new Map<string, Listing>(listings.map((l) => [l.slug, l]));

    const invented = unknownSlugs(plan.steps, bySlug);
    if (invented.length > 0) {
        yield { type: "error", message: `Picked agents that aren't listed: ${invented.join(", ")}` };
        return;
    }

    const projectedTinybar = projectedCost(plan.steps, bySlug);
    yield { type: "plan", plan, projectedTinybar, budgetTinybar: config.maxSpendTinybar };

    // The budget guard runs before the first payment, not between them.
    if (projectedTinybar > config.maxSpendTinybar) {
        yield {
            type: "refused",
            projectedTinybar,
            budgetTinybar: config.maxSpendTinybar,
            skipped: plan.steps.map((s) => bySlug.get(s.slug)?.name ?? s.slug),
        };
        return;
    }

    const signer = createClientHederaSigner(
        config.accountId,
        PrivateKey.fromStringECDSA(config.privateKey),
        { network: config.network },
    );
    const x402 = new x402Client().register("hedera:*", new ExactHederaScheme(signer));

    // `wrapFetchWithPayment` handles 402 → sign → retry internally, so the
    // challenge never surfaces to the caller. Passing it a recording fetch lets
    // us watch the exchange go past and show it — which is most of what makes
    // the protocol legible to someone watching a demo.
    let exchange: Exchange = {};
    const recordingFetch: typeof fetch = async (input, init) => {
        const res = await fetch(input, init);

        if (res.status === 402) {
            const header = res.headers.get("payment-required");
            if (header) {
                try {
                    exchange.challenge = decodePaymentRequiredHeader(header);
                } catch {
                    /* ignore */
                }
            }
        }
        return res;
    };

    const pay = wrapFetchWithPayment(recordingFetch, x402);
    const httpClient = new x402HTTPClient(x402);

    const outputs: unknown[] = [];
    let spentTinybar = 0;

    for (const [index, step] of plan.steps.entries()) {
        const listing = bySlug.get(step.slug)!;
        yield {
            type: "step-start",
            index,
            slug: step.slug,
            name: listing.name,
            priceTinybar: listing.priceTinybar,
        };

        let input: Record<string, unknown>;
        try {
            input = buildInput(step, listing, outputs);
        } catch (err) {
            const message = err instanceof PlanError ? err.message : (err as Error).message;
            yield { type: "step-failed", index, slug: step.slug, message, charged: false };
            break;
        }

        exchange = {};
        let res: Response;
        try {
            res = await pay(`${config.gatewayUrl}/a/${step.slug}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(input),
            });
        } catch (err) {
            yield { type: "step-failed", index, slug: step.slug, message: (err as Error).message, charged: false };
            break;
        }

        if (exchange.challenge) {
            yield { type: "step-402", index, slug: step.slug, challenge: exchange.challenge };
        }

        if (!res.ok) {
            const detail = (await res.json().catch(() => ({}))) as { error?: string };
            yield {
                type: "step-failed",
                index,
                slug: step.slug,
                message: detail.error ?? `HTTP ${res.status}`,
                charged: false,
            };
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
            spentTinybar += listing.priceTinybar;
            yield {
                type: "step-paid",
                index,
                slug: step.slug,
                priceTinybar: listing.priceTinybar,
                payTo: listing.payToAccount,
                txId: settlement.transaction,
                txUrl: hashscanTx(settlement.transaction),
                settlement,
            };
        }

        yield { type: "step-result", index, slug: step.slug, result: body.result };
    }

    yield { type: "done", spentTinybar, result: outputs.at(-1) ?? null };
}
