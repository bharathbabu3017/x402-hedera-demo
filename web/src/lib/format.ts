import { site } from "../data/site.ts";

/** 100_000_000 tinybar = 1 HBAR. Display only — never arithmetic. */
export const formatHbar = (tinybar: number | string): string => {
  const n = typeof tinybar === "string" ? Number(tinybar) : tinybar;
  return `${(n / 1e8).toFixed(4).replace(/\.?0+$/, "")} ℏ`;
};

/**
 * The facilitator returns `<feePayer>@<seconds>.<nanos>`; HashScan's
 * transaction route wants the bare consensus timestamp.
 */
export const hashscanTx = (txId: string): string => {
  const afterPayer = txId.includes("@") ? txId.slice(txId.indexOf("@") + 1) : txId;
  const dashed = afterPayer.match(/^(\d+)-(\d+)$/);
  const timestamp = dashed ? `${dashed[1]}.${dashed[2]}` : afterPayer;
  return `${site.explorer}/transaction/${timestamp}`;
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
