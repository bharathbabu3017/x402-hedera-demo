/**
 * The pure half of the buying agent: turning a plan into concrete request
 * bodies. Kept out of the script so the chaining and coercion rules — the
 * parts most likely to be quietly wrong — are testable.
 */

export interface PlanStep {
    slug: string;
    reason: string;
    input: Array<{ name: string; value: string }>;
    usesOutputOf: number | null;
    outputIntoField: string | null;
}

export interface PricedListing {
    slug: string;
    priceTinybar: number;
    inputSchema: Record<string, { type: string; required: boolean; description: string }>;
}

/** Pulls the most useful text out of an arbitrary agent result, for chaining. */
export const extractText = (result: unknown): string => {
    if (typeof result === "string") return result;
    if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        for (const key of ["summary", "digest", "text", "content", "rationale"]) {
            const value = record[key];
            if (typeof value === "string") return value;
        }
    }
    return JSON.stringify(result);
};

export const projectedCost = (
    steps: PlanStep[],
    bySlug: Map<string, PricedListing>,
): number => steps.reduce((sum, step) => sum + (bySlug.get(step.slug)?.priceTinybar ?? 0), 0);

export const unknownSlugs = (steps: PlanStep[], bySlug: Map<string, PricedListing>): string[] =>
    steps.filter((step) => !bySlug.has(step.slug)).map((step) => step.slug);

export class PlanError extends Error {}

/**
 * Builds one step's request body: name/value pairs, then any chained output
 * from an earlier step, then coercion for fields the listing declares numeric
 * (plan values always arrive as strings).
 */
export const buildInput = (
    step: PlanStep,
    listing: PricedListing,
    previousOutputs: unknown[],
): Record<string, unknown> => {
    const input: Record<string, unknown> = {};
    for (const { name, value } of step.input) input[name] = value;

    if (step.usesOutputOf !== null && step.outputIntoField) {
        const source = previousOutputs[step.usesOutputOf];
        if (source === undefined) {
            throw new PlanError(
                `Step referenced the output of step ${step.usesOutputOf + 1}, which produced nothing`,
            );
        }
        input[step.outputIntoField] = extractText(source);
    }

    for (const [field, spec] of Object.entries(listing.inputSchema)) {
        if (spec.type === "number" && typeof input[field] === "string") {
            const coerced = Number(input[field]);
            if (!Number.isNaN(coerced)) input[field] = coerced;
        }
    }

    return input;
};
