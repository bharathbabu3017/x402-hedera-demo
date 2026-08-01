/** How much page text to hand the model. Enough for a good summary, bounded. */
const MAX_CHARS = 20_000;

export class PageFetchError extends Error {}

/**
 * Fetches a page and reduces it to readable text. Deliberately dependency-free
 * — a regex strip is imprecise but adequate for summarisation, and it keeps a
 * seller agent to a single file.
 */
export const fetchPageText = async (url: string): Promise<{ title: string; text: string }> => {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new PageFetchError(`Not a valid URL: ${url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new PageFetchError("Only http and https URLs are supported");
    }

    let res: Response;
    try {
        res = await fetch(parsed, {
            headers: { "user-agent": "x402-agent-marketplace/0.1 (+demo)" },
            signal: AbortSignal.timeout(15_000),
        });
    } catch (err) {
        const reason = (err as Error).name === "TimeoutError" ? "timed out" : "was unreachable";
        throw new PageFetchError(`Fetching ${url} ${reason}`);
    }

    if (!res.ok) throw new PageFetchError(`Fetching ${url} returned HTTP ${res.status}`);

    const html = await res.text();
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? parsed.hostname;

    const text = html
        // Drop anything that isn't prose before stripping tags.
        .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n\s*\n+/g, "\n\n")
        .trim();

    if (text.length < 50) {
        throw new PageFetchError(
            `No readable text found at ${url} — it may be a JavaScript-rendered page`,
        );
    }

    return { title, text: text.slice(0, MAX_CHARS) };
};
