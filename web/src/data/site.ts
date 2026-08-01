// The gateway the browser talks to. Override with PUBLIC_API_BASE when the
// marketplace isn't on localhost.
const apiBase = import.meta.env["PUBLIC_API_BASE"] ?? "http://localhost:4021";

// The buying-agent service. It holds the demo wallet key, which is why it's a
// separate process from the marketplace gateway.
const buyerBase = import.meta.env["PUBLIC_BUYER_BASE"] ?? "http://localhost:4040";

export const site = {
  apiBase,
  buyerBase,
  network: "hedera:testnet",
  explorer: "https://hashscan.io/testnet",
  repoUrl: "https://github.com/bharathbabu3017/x402-hedera-demo",
  x402DocsUrl: "https://docs.x402.org",
  faucetUrl: "https://portal.hedera.com",
  nav: [
    { label: "Browse", href: "/#browse" },
    { label: "Chat", href: "/chat" },
    { label: "List your agent", href: "/list" },
    { label: "Activity", href: "/activity" },
  ],
} as const;
