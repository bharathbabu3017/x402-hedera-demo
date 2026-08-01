import { describe, it, expect } from "vitest";
import {
    hashscanTx,
    hashscanAccount,
    mirrorNodeTxId,
    toTransactionPath,
    formatHbar,
} from "../src/core/hashscan.js";

// A real settled payment from testnet. Its consensus timestamp was
// 1785548789.683396104 — seven seconds after the valid start below, which is
// exactly why linking the valid start to /transaction/<timestamp> 404s.
const REAL_TX = "0.0.7162784@1785548782.002379713";
const DASHED = "0.0.7162784-1785548782-002379713";

describe("toTransactionPath", () => {
    it("converts the facilitator's @ form to the dashed transaction id", () => {
        expect(toTransactionPath(REAL_TX)).toBe(DASHED);
    });

    it("leaves an already-dashed id alone", () => {
        expect(toTransactionPath(DASHED)).toBe(DASHED);
    });

    it("preserves leading zeros in the nanos, which are significant", () => {
        expect(toTransactionPath("0.0.7162784@1785548782.002379713")).toContain("-002379713");
    });
});

describe("hashscanTx", () => {
    it("links to the transaction id, not the valid-start timestamp", () => {
        expect(hashscanTx(REAL_TX)).toBe(
            `https://hashscan.io/testnet/transaction/${DASHED}`,
        );
    });

    // Guards the original bug: a bare valid-start timestamp resolves to a
    // "transaction not found" page on HashScan.
    it("never emits a bare valid-start timestamp when a payer prefix is present", () => {
        expect(hashscanTx(REAL_TX)).not.toBe(
            "https://hashscan.io/testnet/transaction/1785548782.002379713",
        );
    });

    it("passes a bare timestamp through, assuming it is already a consensus timestamp", () => {
        expect(hashscanTx("1785548789.683396104")).toBe(
            "https://hashscan.io/testnet/transaction/1785548789.683396104",
        );
    });
});

describe("mirrorNodeTxId", () => {
    it("produces the dashed form the REST API wants", () => {
        expect(mirrorNodeTxId(REAL_TX)).toBe(DASHED);
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
