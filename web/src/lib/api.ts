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
