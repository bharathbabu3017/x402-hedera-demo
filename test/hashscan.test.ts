import { describe, it, expect } from "vitest";
import {
    hashscanTx,
    hashscanAccount,
    mirrorNodeTxId,
    formatHbar,
} from "../src/core/hashscan.js";

// The `@` form is what the blocky402 facilitator actually returned on testnet.
const REAL_TX = "0.0.7162784@1785546426.941066223";

describe("hashscanTx", () => {
    it("strips the fee-payer prefix from the facilitator's `@` form", () => {
        expect(hashscanTx(REAL_TX)).toBe(
            "https://hashscan.io/testnet/transaction/1785546426.941066223",
        );
    });

    it("accepts the fully-dashed rendering some SDKs emit", () => {
        expect(hashscanTx("0.0.7162784-1785546426-941066223")).toBe(
            "https://hashscan.io/testnet/transaction/1785546426.941066223",
        );
    });

    it("passes through a bare consensus timestamp unchanged", () => {
        expect(hashscanTx("1785546426.941066223")).toBe(
            "https://hashscan.io/testnet/transaction/1785546426.941066223",
        );
    });
});

describe("mirrorNodeTxId", () => {
    it("converts the `@` form to the dashed form the REST API wants", () => {
        expect(mirrorNodeTxId(REAL_TX)).toBe("0.0.7162784-1785546426-941066223");
    });
});

describe("hashscanAccount", () => {
    it("builds an account explorer url", () => {
        expect(hashscanAccount("0.0.9864248")).toBe(
            "https://hashscan.io/testnet/account/0.0.9864248",
        );
    });
});

describe("formatHbar", () => {
    it("converts tinybar to hbar", () => {
        expect(formatHbar(1_000_000)).toBe("0.01 ℏ");
        expect(formatHbar("2000000")).toBe("0.02 ℏ");
        expect(formatHbar(100_000_000)).toBe("1 ℏ");
    });
});
