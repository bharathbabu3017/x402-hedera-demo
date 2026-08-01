/**
 * Mirror node reads are free and unauthenticated. We use one at listing time to
 * reject payees that don't exist — otherwise the failure surfaces much later,
 * as a confusing settlement error on someone else's first purchase.
 */
export const accountExists = async (
    mirrorNodeUrl: string,
    accountId: string,
): Promise<boolean> => {
    const url = `${mirrorNodeUrl.replace(/\/$/, "")}/api/v1/accounts/${accountId}`;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
        return res.ok;
    } catch {
        // Network trouble shouldn't block a listing — the price of a false
        // negative here is a seller who can't list at all.
        return true;
    }
};
