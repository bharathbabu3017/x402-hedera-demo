// The gateway the browser talks to. Override with PUBLIC_API_BASE when the
// marketplace isn't on localhost.
const apiBase = import.meta.env["PUBLIC_API_BASE"] ?? "http://localhost:4021";

// The buying-agent service. It holds the demo wallet key, which is why it's a
// separate process from the marketplace gateway.
const buyerBase = import.meta.env["PUBLIC_BUYER_BASE"] ?? "http://localhost:4040";

// The example seller service, used only to offer one-click fill on the listing
// form. A real seller would type their own URL.
const sellerBase = import.meta.env["PUBLIC_SELLER_BASE"] ?? "http://localhost:4030";

export const site = {
  apiBase,
  buyerBase,
  sellerBase,
  network: "hedera:testnet",
  explorer: "https://hashscan.io/testnet",
  repoUrl: "https://github.com/bharathbabu3017/x402-hedera-demo",
  x402DocsUrl: "https://docs.x402.org",
  faucetUrl: "https://portal.hedera.com",
  nav: [
    { label: "Chat", href: "/chat" },
    { label: "Agents", href: "/agents" },
    { label: "List your agent", href: "/list" },
    { label: "Activity", href: "/activity" },
  ],
} as const;
