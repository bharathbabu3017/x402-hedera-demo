// Links every settled payment to its on-chain proof.
//
// The facilitator returns transaction ids as `<payer>@<seconds>.<nanos>`
// (verified on testnet: "0.0.7162784@1785548782.002379713"). That timestamp is
// the transaction's *valid start*, NOT its consensus timestamp — for the
// transaction above, consensus landed at 1785548789.683396104, about seven
// seconds later.
//
// This matters because HashScan's `/transaction/<timestamp>` route resolves a
// *consensus* timestamp, so feeding it the valid-start value yields "not
// found". HashScan also accepts the dashed transaction id, which we can build
// locally with no mirror-node lookup — so that's what we link to.

const EXPLORER = "https://hashscan.io/testnet";

/**
 * `0.0.7162784@1785548782.002379713` -> `0.0.7162784-1785548782-002379713`
 *
 * Falls back to returning the input untouched when there's no payer prefix to
 * work with (a bare timestamp is assumed to already be a consensus timestamp).
 */
export const toTransactionPath = (txId: string): string => {
    const at = txId.indexOf("@");
    if (at !== -1) {
        const payer = txId.slice(0, at);
        const [seconds = "", nanos = ""] = txId.slice(at + 1).split(".");
        return `${payer}-${seconds}-${nanos}`;
    }
    // Already dashed: 0.0.7162784-1785548782-002379713
    if (/^\d+\.\d+\.\d+-\d+-\d+$/.test(txId)) return txId;
    return txId;
};

export const hashscanTx = (txId: string): string =>
    `${EXPLORER}/transaction/${toTransactionPath(txId)}`;

export const hashscanAccount = (accountId: string): string =>
    `${EXPLORER}/account/${accountId}`;

/** The mirror node REST API wants the same dashed form. */
export const mirrorNodeTxId = (txId: string): string => toTransactionPath(txId);

/** 100_000_000 tinybar = 1 HBAR. Formatted for display, not arithmetic. */
export const formatHbar = (tinybar: number | string): string => {
    const n = typeof tinybar === "string" ? Number(tinybar) : tinybar;
    return `${(n / 100_000_000).toFixed(4).replace(/\.?0+$/, "")} ℏ`;
};
