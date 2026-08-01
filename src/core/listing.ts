import { randomBytes } from "node:crypto";

/** Native HBAR, in Hedera's account-id form. Not an HTS token. */
export const HBAR_ASSET = "0.0.0";

export interface InputField {
    type: "string" | "number";
    required: boolean;
    description: string;
}

/**
 * A monetised agent endpoint. The seller supplies a plain HTTP `upstreamUrl`
 * and their own `payToAccount`; the gateway fronts it with a paywall and
 * routes payment straight to them. The marketplace never custodies funds.
 */
export interface Listing {
    slug: string;
    name: string;
    description: string;
    tags: string[];
    upstreamUrl: string;
    priceTinybar: number;
    payToAccount: string;
    inputSchema: Record<string, InputField>;
    outputExample: unknown;
    createdAt: string;
}

/** What a listing looks like to a buyer — no owner secret. */
export type PublicListing = Listing & { calls: number; earnedTinybar: number };

export interface ListingDraft {
    slug?: string;
    name: string;
    description: string;
    tags?: string[];
    upstreamUrl: string;
    priceTinybar: number;
    payToAccount: string;
    inputSchema?: Record<string, InputField>;
    outputExample?: unknown;
}

export interface FieldError {
    field: string;
    message: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;
const ACCOUNT_RE = /^\d+\.\d+\.\d+$/;

/** 100 ℏ. A listing priced above this is almost certainly a typo. */
const MAX_PRICE_TINYBAR = 10_000_000_000;

export const slugify = (name: string): string =>
    name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48);

export const newOwnerToken = (): string => randomBytes(24).toString("hex");

/**
 * Shape-level validation only. Whether `payToAccount` actually exists on the
 * network is a separate, network-bound check — see `accountExists`.
 */
export const validateDraft = (draft: ListingDraft): FieldError[] => {
    const errors: FieldError[] = [];

    if (!draft.name?.trim()) {
        errors.push({ field: "name", message: "Name is required" });
    } else if (draft.name.length > 80) {
        errors.push({ field: "name", message: "Name must be 80 characters or fewer" });
    }

    // The discovery LLM reads this to decide whether to hire the agent, so a
    // one-word description makes a listing effectively invisible.
    if (!draft.description?.trim()) {
        errors.push({ field: "description", message: "Description is required" });
    } else if (draft.description.trim().length < 20) {
        errors.push({
            field: "description",
            message:
                "Description must be at least 20 characters — buying agents use it to decide whether to hire you",
        });
    }

    const slug = draft.slug ?? slugify(draft.name ?? "");
    if (!SLUG_RE.test(slug)) {
        errors.push({
            field: "slug",
            message: "Slug must be 2-49 chars, lowercase letters, digits and dashes",
        });
    }

    let upstream: URL | undefined;
    try {
        upstream = new URL(draft.upstreamUrl);
        if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
            errors.push({ field: "upstreamUrl", message: "Upstream must be http or https" });
        }
    } catch {
        errors.push({ field: "upstreamUrl", message: "Upstream must be a valid URL" });
    }

    if (!Number.isInteger(draft.priceTinybar)) {
        errors.push({ field: "priceTinybar", message: "Price must be a whole number of tinybar" });
    } else if (draft.priceTinybar <= 0) {
        errors.push({ field: "priceTinybar", message: "Price must be greater than zero" });
    } else if (draft.priceTinybar > MAX_PRICE_TINYBAR) {
        errors.push({
            field: "priceTinybar",
            message: `Price must be at most ${MAX_PRICE_TINYBAR} tinybar (100 ℏ)`,
        });
    }

    if (!ACCOUNT_RE.test(draft.payToAccount ?? "")) {
        errors.push({ field: "payToAccount", message: "Payee must be a Hedera account id like 0.0.1234" });
    }

    for (const [field, spec] of Object.entries(draft.inputSchema ?? {})) {
        if (spec.type !== "string" && spec.type !== "number") {
            errors.push({
                field: `inputSchema.${field}`,
                message: "Field type must be 'string' or 'number'",
            });
        }
    }

    return errors;
};

export const draftToListing = (draft: ListingDraft): Listing => ({
    slug: draft.slug ?? slugify(draft.name),
    name: draft.name.trim(),
    description: draft.description.trim(),
    tags: (draft.tags ?? []).map((t) => t.toLowerCase().trim()).filter(Boolean),
    upstreamUrl: draft.upstreamUrl,
    priceTinybar: draft.priceTinybar,
    payToAccount: draft.payToAccount,
    inputSchema: draft.inputSchema ?? {},
    outputExample: draft.outputExample ?? null,
    createdAt: new Date().toISOString(),
});

/** Validates a hire request body against the listing's declared input schema. */
export const validateInput = (
    listing: Listing,
    body: Record<string, unknown>,
): FieldError[] => {
    const errors: FieldError[] = [];
    for (const [field, spec] of Object.entries(listing.inputSchema)) {
        const value = body[field];
        if (value === undefined || value === null || value === "") {
            if (spec.required) {
                errors.push({ field, message: `Missing required field: ${field}` });
            }
            continue;
        }
        if (spec.type === "number" && typeof value !== "number") {
            errors.push({ field, message: `Field ${field} must be a number` });
        }
        if (spec.type === "string" && typeof value !== "string") {
            errors.push({ field, message: `Field ${field} must be a string` });
        }
    }
    return errors;
};

/** The x402 `price` shape. Must be `{amount, asset}` — a bare number silently fails verification. */
export const priceFor = (listing: Listing): { amount: string; asset: string } => ({
    amount: String(listing.priceTinybar),
    asset: HBAR_ASSET,
});

/** `/a/sentiment` -> `sentiment` */
export const slugFromPath = (path: string): string => {
    const [withoutQuery = ""] = path.split("?");
    return withoutQuery.split("/").filter(Boolean).pop() ?? "";
};
