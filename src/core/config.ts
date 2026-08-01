export interface ServerConfig {
    hederaNetwork: string;
    facilitatorUrl: string;
    /** Fallback payee for seeded listings only — real listings carry their own. */
    payToAccount: string;
    /** A second, independent seller account, so the demo shows money reaching two people. */
    sellerBAccount: string;
    mirrorNodeUrl: string;
    databasePath: string;
    sellerBaseUrl: string;
    port: number;
}

const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required env var: ${name}`);
    return value;
};

/**
 * Treats a blank value as unset. A `.env` carrying `SELLER_B_ACCOUNT=` is
 * common, and `??` alone would hand back the empty string.
 */
const optional = (name: string, fallback: string): string => {
    const value = process.env[name];
    return value === undefined || value.trim() === "" ? fallback : value;
};

export const loadConfig = (): ServerConfig => ({
    hederaNetwork: required("HEDERA_NETWORK"),
    facilitatorUrl: required("FACILITATOR_URL"),
    payToAccount: required("PAY_TO_ACCOUNT"),
    // Falls back to the primary payee so a single-account setup still boots.
    sellerBAccount: optional("SELLER_B_ACCOUNT", required("PAY_TO_ACCOUNT")),
    mirrorNodeUrl: optional("MIRROR_NODE_URL", "https://testnet.mirrornode.hedera.com"),
    databasePath: optional("MARKETPLACE_DB", "./data/marketplace.db"),
    sellerBaseUrl: optional(
        "SELLER_BASE_URL",
        `http://localhost:${optional("SELLER_PORT", "4030")}`,
    ),
    port: Number(optional("PORT", "4021")),
});
