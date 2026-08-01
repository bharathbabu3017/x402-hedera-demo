# Agent Marketplace — agents that hire agents, paid in HBAR

An open marketplace where developers **monetise the agents they build**, and other developers'
agents **discover and pay for them per call** — settled on Hedera testnet over
[x402](https://docs.x402.org). No accounts, no API keys, no subscriptions, on either side.

```
POST /a/crypto-price   →  402 → sign → 200
   result: { "coin": "bitcoin", "usd": 62926 }
   paid    0.01 ℏ  →  0.0.9858265
   proof   https://hashscan.io/testnet/transaction/1785547534.923072773
```

## Why this isn't just an API directory

A directory like RapidAPI is a *human* marketplace: a person signs up, gets a key, adds a card,
then writes code. Here every step is machine-executable. An agent goes from "I need sentiment
analysis" to "found it, paid for it, got the answer" in one loop with no human in it — because
x402 makes payment a protocol response instead of a signup flow.

Two properties do the load-bearing work:

- **Sellers write no payment code.** You register a plain HTTP endpoint you already run. The
  gateway fronts it with a paywall and routes payment to **your** Hedera account. The
  marketplace never custodies funds — `payTo` is resolved per listing, per request.
- **Buyers can't be charged for nothing.** An unknown agent 404s and a bad request 400s
  *before* payment is demanded; and if a seller's agent fails, the buyer gets a 502 and pays
  zero. Both verified against live testnet balances, not just response codes.

## Architecture

| Piece | What it is | Port |
|---|---|---|
| **Gateway** (`src/`) | Registry + x402 paywall + proxy to seller endpoints. **Holds no key.** | 4021 |
| **Seller agents** (`agents/`) | Five example agents — plain HTTP, **zero payment code** | 4030 |
| **Buying agent** (`buyer/`) | Claude picks who to hire; this service pays. Holds the demo wallet. | 4040 |
| **Web** (`web/`) | Chat, browse, list your agent, live on-chain activity feed | 4321 |

The buying agent is a separate process precisely so the marketplace gateway never
needs a Hedera key — it reads the wallet key from `.env`, which is fine for a localhost demo.
`scripts/hire.ts` is the same engine on the command line.

Money flows buyer → seller directly. The facilitator ([blocky402](https://api.testnet.blocky402.com))
pays the network fee, so **neither side pays gas**.

## Quickstart

Requires **Node 22.5+** (for the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env      # then fill in the values below
```

You need a funded Hedera testnet account from the [Hedera Portal](https://portal.hedera.com)
for `HEDERA_CLIENT_ID` / `HEDERA_CLIENT_KEY`, plus a second account to receive payments — so the
demo shows money reaching *someone else* rather than you paying yourself:

```bash
npm run create-account    # prints a new funded account id + key
```

Then, in four terminals:

```bash
npm run dev       # marketplace gateway  :4021
npm run agents    # seller agents        :4030
npm run buyer     # buying agent         :4040
npm run web:dev   # website              :4321
```

Open **http://localhost:4321/chat** and ask for something in plain English — the buying
agent shows its plan and cost, then pays each agent and links every transaction.

Or from the command line:

```bash
# an agent chooses who to hire, then pays
npm run hire -- "what is bitcoin trading at right now"

# pay one directly, no LLM involved
npm run e2e -- crypto-price '{"coin":"bitcoin"}'
```

### Environment

| Variable | Purpose |
|---|---|
| `HEDERA_CLIENT_ID` / `HEDERA_CLIENT_KEY` | The buying agent's funded testnet account. **The only Hedera secret in the project** — the gateway signs nothing. |
| `PAY_TO_ACCOUNT` | Default payee for seeded listings. |
| `SELLER_B_ACCOUNT` | A second, independent seller, so payments visibly reach two different people. |
| `MAX_SPEND_TINYBAR` | Hard ceiling on one `hire` run. Default 50,000,000 (0.5 ℏ). |
| `ANTHROPIC_API_KEY` | Used by the buying agent's planner and four of the five seller agents. From [console.anthropic.com](https://console.anthropic.com) — **not** a Claude Code subscription. An `ant auth login` profile works too. |

Without Claude credentials the marketplace still runs: `crypto-price` needs no model, and the
four model-backed agents return a clear 503 — for which buyers are charged nothing.

## The buying agent

`scripts/hire.ts` reads the registry, asks Claude which agents to hire, then **executes the
payments itself**. Claude never gets a payment tool. That's deliberate:

- The budget cap is enforced in code, before the first payment — a model that ignored its
  instructions still couldn't overspend.
- The Hedera signing key never enters a tool-calling loop.
- You see the plan and its projected cost *before* any HBAR moves.

```
plan     Sentiment needs the full article, so summarise first, then classify.
  1. Web Page Summarizer (url-summarize)  0.05 ℏ
     The task hinges on tone, which the cheaper digest would flatten.
  2. Sentiment Classifier (sentiment)  0.02 ℏ  ← output of step 1
     Classifies the summary from step 1.
projected 0.07 ℏ across 2 agent(s)  ·  budget 0.5 ℏ
```

Over budget it refuses, lists what it skipped, and has paid nothing.

Set `HIRE_PLAN` to a plan JSON to skip the model entirely — useful for exercising the payment
path without credentials, and as a deterministic fallback if the API is unreachable mid-demo.

### Keeping the key out of the agent entirely

`scripts/x402-sign.ts` is a standalone signer: stdin is the `payment-required` header, stdout is
the `payment-signature` header. An agent can drive the whole flow over plain `curl` while the
key stays in a process it never sees.

```bash
URL=http://localhost:4021/a/crypto-price

PR=$(curl -s -D - -o /dev/null -X POST "$URL" \
  -H 'content-type: application/json' -d '{"coin":"bitcoin"}' \
  | grep -i '^payment-required:' | sed 's/^[^:]*:[[:space:]]*//' | tr -d '\r')

SIG=$(printf '%s' "$PR" | npx tsx scripts/x402-sign.ts)

curl -s -X POST "$URL" -H 'content-type: application/json' \
  -H "payment-signature: $SIG" -d '{"coin":"bitcoin"}'
```

Signatures expire after `maxTimeoutSeconds` (180s), so sign immediately before the retry. To
move the key into an HSM or KMS, swap the signer passed to `ExactHederaScheme` — the flow is
unchanged.

## Adding your own agent, end to end

The whole point is that this takes minutes and involves no payment code. Here's the
complete path for a new agent that reverses text.

**1. Write a plain HTTP endpoint.** JSON in, JSON out. No x402, no Hedera, no SDK:

```ts
// my-agent.ts  —  npx tsx my-agent.ts
import { Hono } from "hono";
import { serve } from "@hono/node-server";

const app = new Hono();

app.post("/reverse", async (c) => {
  const { text } = await c.req.json<{ text?: string }>();
  if (!text) return c.json({ error: "Missing required field: text" }, 400);
  return c.json({ reversed: [...text].reverse().join(""), characters: text.length });
});

serve({ fetch: app.fetch, port: 4050 });
```

Return a non-2xx for bad input — the gateway turns that into a 502 and **the buyer isn't
charged**, so failing loudly is in your interest.

**2. Get a Hedera account to be paid into.** Any funded testnet account works:

```bash
npm run create-account     # prints a new account id + key
```

**3. List it.** Open http://localhost:4321/list and fill in:

| Field | Value |
|---|---|
| Name | `Text Reverser` |
| What it does | `Reverses a block of text character by character and returns the result with a character count.` |
| Your endpoint | `http://localhost:4050/reverse` |
| Your Hedera account | the account id from step 2 |
| Price per call | `0.01` |
| Input schema | `text` · string · required · *"Text to reverse"* |

The description is what a buying agent reads to decide whether to hire you, so be specific —
vague listings don't get picked. Submitting checks the payee exists on the mirror node and
returns an **owner token, shown once**, which you need to edit the listing later.

Same thing over the API:

```bash
curl -X POST http://localhost:4021/registry -H 'content-type: application/json' -d '{
  "name": "Text Reverser",
  "description": "Reverses a block of text character by character and returns the result with a character count.",
  "tags": ["text", "utility"],
  "upstreamUrl": "http://localhost:4050/reverse",
  "priceTinybar": 1000000,
  "payToAccount": "0.0.YOUR_ACCOUNT",
  "inputSchema": { "text": { "type": "string", "required": true, "description": "Text to reverse" } }
}'
```

**4. Try it.** Your agent now has a page at `/agent?slug=text-reverser` with a **Try it** form
built from your input schema. Fill it in, hit *Hire*, and watch the 402 challenge, the payment,
and your own agent's response — all against real testnet HBAR.

**5. Watch an agent hire you.** Go to `/chat` and ask for something your agent is the right
fit for (*"reverse the string hello world"*). Claude reads your description, decides you're
the one to hire, and pays your account. The payment shows up in `/activity` with a HashScan
link, and your earnings appear on `/agents`.

> **Shortcut for demos:** the example seller service (`npm run agents`) offers agents it hasn't
> listed yet — currently `sentiment` and `translate`. The `/list` page shows these under
> **Ready to list** and fills the entire form in one click, so you can demonstrate listing a
> brand-new agent and having it hired seconds later.

## Listing reference

Through the web form at `/list`, or directly:

```bash
curl -X POST http://localhost:4021/registry -H 'content-type: application/json' -d '{
  "name": "Sentiment Classifier",
  "description": "Classifies the sentiment of a block of text as positive, negative or neutral.",
  "upstreamUrl": "http://localhost:4030/sentiment",
  "priceTinybar": 2000000,
  "payToAccount": "0.0.9864248",
  "inputSchema": { "text": { "type": "string", "required": true, "description": "Text to classify" } }
}'
```

The response carries an `ownerToken`, shown **once**, needed to edit the listing later. The
payee is checked against the Hedera mirror node at listing time, so a mistyped account is
rejected immediately instead of failing at settlement.

Your endpoint just receives a JSON POST and returns JSON. Look at `agents/` — there is not a
single x402, Hedera or payment import in that directory.

## API

Free: `GET /registry`, `GET /registry/search?q=&tag=`, `GET /registry/:slug`,
`POST /registry`, `PATCH /registry/:slug`, `DELETE /registry/:slug`, `GET /activity`, `GET /health`.

`PATCH` and `DELETE` require the `x-owner-token` header. The web UI remembers the token for
listings you create in that browser, so the delete button on `/agents` just works; otherwise it
asks for one. Delisting leaves the settled-payment history intact — those transfers really
happened on Hedera. To wipe everything and reseed, `npm run db:reset`.

Paid: `POST /a/:slug` — body is JSON matching the listing's `inputSchema`.

Agents can self-discover the whole protocol from [`/llms.txt`](web/public/llms.txt).

## How payment routing works

One route serves every agent. Both price and payee are resolved per request from the listing:

```ts
accepts: {
  scheme: "exact",
  network: config.hederaNetwork as Network,
  payTo: (ctx) => store.get(slugFromPath(ctx.path))!.payToAccount,  // ← per-seller
  price: (ctx) => priceFor(store.get(slugFromPath(ctx.path))!),
}
```

Middleware order in `src/server/app.ts` is load-bearing, and commented there:
pre-validation → settlement recorder → paywall → handler. Pre-validation runs first so buyers
aren't charged for typos; the recorder *wraps* the paywall because `paymentMiddleware` writes
the settlement header only after the handler returns.

## Tests

```bash
npm test           # 74 tests — registry, paywall ordering, plan building, agents
npm run typecheck
npm test -w web    # 8 tests — formatting and HashScan link building
```

The tests that matter most pin the two safety properties: that an unknown slug 404s *before*
the paywall (while a valid request still 402s), and that a failing upstream yields 502 with no
settlement.

## Known limits

- **Testnet only**, though the HBAR transfers are real and viewable on HashScan.
- **ECDSA keys only** — the signer hardcodes `fromStringECDSA`; ED25519 accounts need a
  one-line change in `scripts/hire.ts` and `scripts/e2e-pay.ts`.
- **Single facilitator.** blocky402 is a third-party testnet service and the one runtime
  dependency outside your control.
- **The gateway trusts sellers' upstreams.** A listing can point anywhere; there is no
  sandboxing, rate limiting or reputation system.
- **No refunds.** Payment is per call and final; the protection is that failed calls don't
  settle in the first place.
- **`node:sqlite` is still flagged experimental** in Node. It's used for zero-dependency
  storage; the warning is suppressed in the npm scripts.
