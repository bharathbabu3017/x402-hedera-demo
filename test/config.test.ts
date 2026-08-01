import { describe, it, expect, afterEach, vi } from "vitest";
import { loadConfig } from "../src/core/config.js";

afterEach(() => vi.unstubAllEnvs());

const stubRequired = () => {
    vi.stubEnv("HEDERA_NETWORK", "hedera:testnet");
    vi.stubEnv("FACILITATOR_URL", "https://api.testnet.blocky402.com");
    vi.stubEnv("PAY_TO_ACCOUNT", "0.0.1234");
};

describe("loadConfig", () => {
    it("throws when a required env var is missing", () => {
        vi.stubEnv("HEDERA_NETWORK", "");
        vi.stubEnv("FACILITATOR_URL", "");
        vi.stubEnv("PAY_TO_ACCOUNT", "");
        expect(() => loadConfig()).toThrow(/FACILITATOR_URL|HEDERA_NETWORK|PAY_TO_ACCOUNT/);
    });

    it("applies defaults for the optional vars", () => {
        stubRequired();
        vi.stubEnv("SELLER_B_ACCOUNT", "");
        vi.stubEnv("MIRROR_NODE_URL", "");
        vi.stubEnv("MARKETPLACE_DB", "");
        vi.stubEnv("PORT", "");
        vi.stubEnv("SELLER_PORT", "");
        vi.stubEnv("SELLER_BASE_URL", "");

        const config = loadConfig();
        expect(config.port).toBe(4021);
        expect(config.databasePath).toBe("./data/marketplace.db");
        expect(config.mirrorNodeUrl).toBe("https://testnet.mirrornode.hedera.com");
        expect(config.sellerBaseUrl).toBe("http://localhost:4030");
    });

    it("falls back to the primary payee when no second seller account is set", () => {
        stubRequired();
        vi.stubEnv("SELLER_B_ACCOUNT", "");
        expect(loadConfig().sellerBAccount).toBe("0.0.1234");
    });

    it("uses a distinct second seller account when provided", () => {
        stubRequired();
        vi.stubEnv("SELLER_B_ACCOUNT", "0.0.9864248");
        expect(loadConfig().sellerBAccount).toBe("0.0.9864248");
    });
});
