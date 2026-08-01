import { site } from "../data/site.ts";

/** 100_000_000 tinybar = 1 HBAR. Display only — never arithmetic. */
export const formatHbar = (tinybar: number | string): string => {
  const n = typeof tinybar === "string" ? Number(tinybar) : tinybar;
  return `${(n / 1e8).toFixed(4).replace(/\.?0+$/, "")} ℏ`;
};

/**
 * The facilitator returns `<payer>@<seconds>.<nanos>`, where the timestamp is
 * the transaction's *valid start* — not its consensus timestamp. HashScan's
 * `/transaction/<timestamp>` route resolves a consensus timestamp, so linking
 * the valid-start value gives "not found". The dashed transaction id works and
 * needs no lookup.
 */
export const hashscanTx = (txId: string): string => {
  const at = txId.indexOf("@");
  if (at !== -1) {
    const payer = txId.slice(0, at);
    const [seconds = "", nanos = ""] = txId.slice(at + 1).split(".");
    return `${site.explorer}/transaction/${payer}-${seconds}-${nanos}`;
  }
  return `${site.explorer}/transaction/${txId}`;
};

export const hashscanAccount = (accountId: string): string =>
  `${site.explorer}/account/${accountId}`;

export const relativeTime = (iso: string): string => {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};
