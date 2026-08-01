// The gateway the browser talks to. Override with PUBLIC_API_BASE when the
// marketplace isn't on localhost.
const apiBase = import.meta.env["PUBLIC_API_BASE"] ?? "http://localhost:4021";

export const site = {
  apiBase,
  network: "hedera:testnet",
  explorer: "https://hashscan.io/testnet",
  repoUrl: "https://github.com/bharathbabu3017/x402-hedera-demo",
  x402DocsUrl: "https://docs.x402.org",
  faucetUrl: "https://portal.hedera.com",
  nav: [
    { label: "Browse", href: "/#browse" },
    { label: "List your agent", href: "/list" },
    { label: "Activity", href: "/activity" },
  ],
} as const;
