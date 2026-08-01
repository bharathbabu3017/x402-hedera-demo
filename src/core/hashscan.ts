// Links every settled payment to its on-chain proof.
//
// The facilitator returns transaction ids as `<feePayer>@<seconds>.<nanos>`
// (verified on testnet: "0.0.7162784@1785546426.941066223"). HashScan's
// transaction route wants the bare `<seconds>.<nanos>` consensus timestamp,
// while the mirror node REST API wants `<feePayer>-<seconds>-<nanos>`.

const EXPLORER = "https://hashscan.io/testnet";

/** `0.0.7162784@1785546426.941066223` -> `1785546426.941066223` */
const consensusTimestamp = (txId: string): string => {
    const afterPayer = txId.includes("@") ? txId.slice(txId.indexOf("@") + 1) : txId;
    // Some renderings use dashes throughout: 0.0.x-1785546426-941066223
    const dashed = afterPayer.match(/^(\d+)-(\d+)$/);
    if (dashed) return `${dashed[1]}.${dashed[2]}`;
    const fullyDashed = txId.match(/^\d+\.\d+\.\d+-(\d+)-(\d+)$/);
    if (fullyDashed) return `${fullyDashed[1]}.${fullyDashed[2]}`;
    return afterPayer;
};

export const hashscanTx = (txId: string): string =>
    `${EXPLORER}/transaction/${consensusTimestamp(txId)}`;

export const hashscanAccount = (accountId: string): string =>
    `${EXPLORER}/account/${accountId}`;

/** Mirror node REST wants `<feePayer>-<seconds>-<nanos>`. */
export const mirrorNodeTxId = (txId: string): string => {
    const at = txId.indexOf("@");
    if (at === -1) return txId;
    return `${txId.slice(0, at)}-${consensusTimestamp(txId).replace(".", "-")}`;
};

/** 100_000_000 tinybar = 1 HBAR. Formatted for display, not arithmetic. */
export const formatHbar = (tinybar: number | string): string => {
    const n = typeof tinybar === "string" ? Number(tinybar) : tinybar;
    return `${(n / 100_000_000).toFixed(4).replace(/\.?0+$/, "")} ℏ`;
};
