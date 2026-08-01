import { describe, it, expect, afterEach, vi } from "vitest";
import { app } from "../agents/app.js";
import { fetchPageText, PageFetchError } from "../agents/page.js";

afterEach(() => vi.restoreAllMocks());

const html = (body: string, title = "Example Page") =>
    new Response(`<html><head><title>${title}</title></head><body>${body}</body></html>`, {
        status: 200,
        headers: { "content-type": "text/html" },
    });

describe("fetchPageText", () => {
    it("extracts the title and readable prose", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            html("<p>Hedera settles transactions in about three seconds.</p>"),
        );
        const page = await fetchPageText("https://example.com");
        expect(page.title).toBe("Example Page");
        expect(page.text).toContain("Hedera settles transactions");
    });

    it("drops script and style content, which would otherwise dominate the summary", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            html(
                "<script>var secret = 'do not summarise me';</script>" +
                    "<style>.a{color:red}</style>" +
                    "<p>The actual article text lives here and is long enough to pass.</p>",
            ),
        );
        const page = await fetchPageText("https://example.com");
        expect(page.text).not.toContain("do not summarise me");
        expect(page.text).not.toContain("color:red");
        expect(page.text).toContain("The actual article text");
    });

    it("decodes html entities", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            html("<p>Tom &amp; Jerry said &quot;hello&quot; to the whole wide world today.</p>"),
        );
        const page = await fetchPageText("https://example.com");
        expect(page.text).toContain('Tom & Jerry said "hello"');
    });

    it("rejects a non-http scheme", async () => {
        await expect(fetchPageText("ftp://example.com")).rejects.toBeInstanceOf(PageFetchError);
    });

    it("rejects a page with no readable text, rather than summarising nothing", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(html("<div></div>"));
        await expect(fetchPageText("https://example.com")).rejects.toThrow(/No readable text/);
    });

    it("surfaces an upstream error status", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 404 }));
        await expect(fetchPageText("https://example.com")).rejects.toThrow(/HTTP 404/);
    });
});

describe("crypto-price", () => {
    const post = (body: unknown) =>
        app.request("/crypto-price", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });

    it("returns a usd spot price", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            Response.json({ bitcoin: { usd: 62926 } }),
        );
        const res = await post({ coin: "bitcoin" });
        expect(res.status).toBe(200);
        expect((await res.json()) as { usd: number }).toMatchObject({ coin: "bitcoin", usd: 62926 });
    });

    it("400s an unknown coin id rather than returning a null price", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
        expect((await post({ coin: "notacoin" })).status).toBe(400);
    });

    it("400s a missing coin field", async () => {
        expect((await post({})).status).toBe(400);
    });

    it("502s when the upstream price source is down", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 503 }));
        expect((await post({ coin: "bitcoin" })).status).toBe(502);
    });
});

describe("credential handling", () => {
    it("503s a model-backed agent when no credentials are configured", async () => {
        vi.stubEnv("ANTHROPIC_API_KEY", "");
        vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "");
        const res = await app.request("/sentiment", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: "I love this" }),
        });
        expect(res.status).toBe(503);
        expect((await res.json()) as { error: string }).toMatchObject({
            error: expect.stringContaining("ANTHROPIC_API_KEY"),
        });
        vi.unstubAllEnvs();
    });
});
