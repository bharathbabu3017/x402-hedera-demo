// Minimal payer: hires one agent by slug, no LLM involved.
//
//   npm run e2e -- crypto-price '{"coin":"bitcoin"}'
//
// This is the smallest thing that proves the rail works end to end. For the
// agent that *chooses* who to hire, see `npm run hire`.
import "dotenv/config";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { hashscanTx, formatHbar } from "../src/core/hashscan.js";

const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var: ${name}`);
    return value;
};

const [slug = "crypto-price", rawInput = '{"coin":"bitcoin"}'] = process.argv.slice(2);
const gateway = process.env.SERVER_URL ?? "http://localhost:4021";

// Note: fromStringECDSA matches Hedera Portal default accounts.
// If your account key is ED25519, switch to PrivateKey.fromStringED25519.
const signer = createClientHederaSigner(
    required("HEDERA_CLIENT_ID"),
    PrivateKey.fromStringECDSA(required("HEDERA_CLIENT_KEY")),
    { network: process.env.HEDERA_NETWORK ?? "hedera:testnet" },
);

const client = new x402Client().register("hedera:*", new ExactHederaScheme(signer));
const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const httpClient = new x402HTTPClient(client);

const url = `${gateway}/a/${slug}`;
console.log(`-> POST ${url}`);
console.log(`   input ${rawInput}`);

const res = await fetchWithPayment(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawInput,
});

console.log(`<- HTTP ${res.status}`);
console.log(JSON.stringify(await res.json(), null, 2));

try {
    const settlement = httpClient.getPaymentSettleResponse((n) => res.headers.get(n));
    if (settlement?.success && settlement.transaction) {
        const detail = await fetch(`${gateway}/registry/${slug}`);
        const { listing } = (await detail.json()) as { listing: { priceTinybar: number } };

        console.log(`\npaid   ${formatHbar(listing.priceTinybar)}`);
        console.log(`payer  ${settlement.payer}`);
        console.log(`proof  ${hashscanTx(settlement.transaction)}`);
    }
} catch {
    console.log("\n(no payment was settled for this request)");
}
