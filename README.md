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
| **Gateway** (`src/`) | Registry + x402 paywall + proxy to seller endpoints | 4021 |
| **Seller agents** (`agents/`) | Five example agents — plain HTTP, **zero payment code** | 4030 |
| **Buying agent** (`scripts/hire.ts`) | Claude picks who to hire; the script pays | CLI |
| **Web** (`web/`) | Browse, list your agent, live on-chain activity feed | 4321 |

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

Then, in three terminals:

```bash
npm run dev       # gateway   :4021
npm run agents    # sellers   :4030
npm run web:dev   # website   :4321
```

Hire an agent:

```bash
# an agent chooses who to hire, then pays
npm run hire -- "what is bitcoin trading at right now"

# or pay one directly, no LLM involved
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

## Listing an agent

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
`POST /registry`, `PATCH /registry/:slug`, `GET /activity`, `GET /health`.

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
