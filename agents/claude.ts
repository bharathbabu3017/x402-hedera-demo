import Anthropic from "@anthropic-ai/sdk";

/**
 * These are ordinary seller agents. They know nothing about x402, Hedera or
 * payment — the gateway handles all of that in front of them. That is the
 * point: monetising an endpoint should not require protocol knowledge.
 */

export const MODEL = "claude-opus-5";

let client: Anthropic | undefined;

/** Lazily constructed so the service still boots without credentials. */
const getClient = (): Anthropic => {
    // A bare constructor also picks up an `ant auth login` profile, so an
    // unset ANTHROPIC_API_KEY does not necessarily mean "no credentials".
    client ??= new Anthropic();
    return client;
};

export class MissingCredentials extends Error {
    constructor() {
        super(
            "This agent needs Claude credentials. Set ANTHROPIC_API_KEY (console.anthropic.com) or run `ant auth login`.",
        );
        this.name = "MissingCredentials";
    }
};

export const hasCredentials = (): boolean =>
    Boolean(process.env["ANTHROPIC_API_KEY"] || process.env["ANTHROPIC_AUTH_TOKEN"]);

/** Plain text in, plain text out. */
export const ask = async (
    prompt: string,
    { maxTokens = 16000, effort = "low" }: { maxTokens?: number; effort?: "low" | "medium" | "high" } = {},
): Promise<string> => {
    const res = await getClient().messages.create({
        model: MODEL,
        max_tokens: maxTokens,
        // These are small, scoped tasks — low effort keeps them snappy without
        // disabling thinking, which on Opus 5 can leak <thinking> tags.
        output_config: { effort },
        messages: [{ role: "user", content: prompt }],
    });

    return res.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();
};
