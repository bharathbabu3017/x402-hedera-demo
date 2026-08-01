import { site } from "../data/site.ts";

export interface InputField {
  type: "string" | "number";
  required: boolean;
  description: string;
}

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
  calls: number;
  earnedTinybar: number;
}

export interface PaidCall {
  id: number;
  slug: string;
  tinybar: number;
  txId: string;
  payer: string;
  createdAt: string;
  agentName: string;
  payTo?: string;
  txUrl: string;
  payerUrl: string;
  payToUrl?: string;
}

export class GatewayDown extends Error {
  constructor() {
    super(`Can't reach the marketplace at ${site.apiBase}`);
  }
}

const get = async <T>(path: string): Promise<T> => {
  let res: Response;
  try {
    res = await fetch(`${site.apiBase}${path}`);
  } catch {
    // A refused connection throws rather than returning a status, and "the
    // gateway isn't running" is by far the most common cause.
    throw new GatewayDown();
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
};

export const getRegistry = async (): Promise<Listing[]> =>
  (await get<{ listings: Listing[] }>("/registry")).listings;

export const getListing = async (slug: string): Promise<Listing> =>
  (await get<{ listing: Listing }>(`/registry/${encodeURIComponent(slug)}`)).listing;

export const getActivity = async (limit = 50): Promise<PaidCall[]> =>
  (await get<{ calls: PaidCall[] }>(`/activity?limit=${limit}`)).calls;

export interface CreateResult {
  listing: Listing;
  ownerToken: string;
  hireUrl: string;
  payToUrl: string;
}

export interface FieldError {
  field: string;
  message: string;
}

export class ListingRejected extends Error {
  constructor(readonly errors: FieldError[]) {
    super(errors.map((e) => e.message).join("\n"));
  }
}

// ── buying agent service ─────────────────────────────────────────────────────

export interface Wallet {
  accountId: string;
  accountUrl: string;
  balanceTinybar: number | null;
  budgetTinybar: number;
  network: string;
  gatewayUrl: string;
}

export interface PlanStep {
  slug: string;
  reason: string;
  usesOutputOf: number | null;
}

/** Mirrors `BuyerEvent` in src/core/buyer.ts. */
export type BuyerEvent =
  | { type: "listings"; listings: Listing[] }
  | { type: "thinking" }
  | {
      type: "plan";
      plan: { reasoning: string; steps: PlanStep[] };
      projectedTinybar: number;
      budgetTinybar: number;
    }
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
  | { type: "error"; message: string }
  | { type: "close" };

export const getWallet = async (): Promise<Wallet> => {
  let res: Response;
  try {
    res = await fetch(`${site.buyerBase}/wallet`);
  } catch {
    throw new GatewayDown();
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Wallet;
};

/**
 * Streams the buy as it happens. Uses fetch + a ReadableStream rather than
 * EventSource because the task has to go up in a POST body.
 */
export async function* streamChat(task: string): AsyncGenerator<BuyerEvent> {
  let res: Response;
  try {
    res = await fetch(`${site.buyerBase}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task }),
    });
  } catch {
    throw new GatewayDown();
  }

  if (!res.ok || !res.body) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `HTTP ${res.status}`);
  }

  yield* readSSE(res.body);
}

/** Parses an SSE body into events. Frames are separated by a blank line. */
async function* readSSE(body: ReadableStream): AsyncGenerator<BuyerEvent> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;

    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const event = JSON.parse(line.slice(5).trim()) as BuyerEvent;
      if (event.type === "close") return;
      yield event;
    }
  }
}

/** Hire one named agent directly — no model, inputs supplied by the caller. */
export async function* streamHire(
  slug: string,
  input: Record<string, unknown>,
): AsyncGenerator<BuyerEvent> {
  let res: Response;
  try {
    res = await fetch(`${site.buyerBase}/hire`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, input }),
    });
  } catch {
    throw new GatewayDown();
  }

  if (!res.ok || !res.body) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `HTTP ${res.status}`);
  }

  yield* readSSE(res.body);
}

export interface AgentOffer {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  upstreamUrl: string;
  suggestedPriceTinybar: number;
  inputSchema: Record<string, InputField>;
  outputExample: unknown;
  needsModel: boolean;
}

/** The example seller's catalogue, for one-click fill on the listing form. */
export const getSellerCatalogue = async (): Promise<AgentOffer[]> => {
  const res = await fetch(`${site.sellerBase}/catalogue`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return ((await res.json()) as { agents: AgentOffer[] }).agents;
};

export const createListing = async (draft: unknown): Promise<CreateResult> => {
  let res: Response;
  try {
    res = await fetch(`${site.apiBase}/registry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
  } catch {
    throw new GatewayDown();
  }

  const body = (await res.json()) as CreateResult & { error?: string; errors?: FieldError[] };
  if (!res.ok) {
    throw new ListingRejected(body.errors ?? [{ field: "", message: body.error ?? "Rejected" }]);
  }
  return body;
};
