import { describe, it, expect } from "vitest";
import { formatHbar, hashscanTx, hashscanAccount, relativeTime } from "../src/lib/format.js";

describe("formatHbar", () => {
  it("converts listing prices", () => {
    expect(formatHbar(1_000_000)).toBe("0.01 ℏ");
    expect(formatHbar("2000000")).toBe("0.02 ℏ");
    expect(formatHbar(5_000_000)).toBe("0.05 ℏ");
  });

  it("converts whole HBAR", () => {
    expect(formatHbar(100_000_000)).toBe("1 ℏ");
  });

  it("shows zero earnings", () => {
    expect(formatHbar(0)).toBe("0 ℏ");
  });
});

describe("hashscanTx", () => {
  // The `@` form is what the facilitator actually returns on testnet.
  it("strips the fee-payer prefix", () => {
    expect(hashscanTx("0.0.7162784@1785546426.941066223")).toBe(
      "https://hashscan.io/testnet/transaction/1785546426.941066223",
    );
  });

  it("passes a bare consensus timestamp through", () => {
    expect(hashscanTx("1785546426.941066223")).toBe(
      "https://hashscan.io/testnet/transaction/1785546426.941066223",
    );
  });
});

describe("hashscanAccount", () => {
  it("builds an account explorer url", () => {
    expect(hashscanAccount("0.0.9864248")).toBe(
      "https://hashscan.io/testnet/account/0.0.9864248",
    );
  });
});

describe("relativeTime", () => {
  it("describes recent timestamps", () => {
    const secondsAgo = new Date(Date.now() - 30_000).toISOString();
    expect(relativeTime(secondsAgo)).toMatch(/^\d+s ago$/);

    const hoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
    expect(relativeTime(hoursAgo)).toBe("3h ago");
  });

  it("never shows a negative age for a row written a moment ago", () => {
    const slightlyFuture = new Date(Date.now() + 500).toISOString();
    expect(relativeTime(slightlyFuture)).toBe("0s ago");
  });
});
