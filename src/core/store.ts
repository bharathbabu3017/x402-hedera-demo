import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { Listing, PublicListing } from "./listing.js";

// `node:sqlite` is a Node 22+ builtin that postdates Vite's builtin-module
// list, so a static import breaks under vitest's transform. Loading it through
// createRequire keeps runtime behaviour identical and skips the bundler.
const { DatabaseSync } = createRequire(import.meta.url)(
    "node:sqlite",
) as typeof import("node:sqlite");

export interface PaidCall {
    id: number;
    slug: string;
    tinybar: number;
    txId: string;
    payer: string;
    createdAt: string;
}

interface ListingRow {
    slug: string;
    name: string;
    description: string;
    tags: string;
    upstream_url: string;
    price_tinybar: number;
    pay_to_account: string;
    input_schema: string;
    output_example: string;
    owner_token: string;
    created_at: string;
    calls: number;
    earned_tinybar: number;
}

const toPublic = (row: ListingRow): PublicListing => ({
    slug: row.slug,
    name: row.name,
    description: row.description,
    tags: JSON.parse(row.tags) as string[],
    upstreamUrl: row.upstream_url,
    priceTinybar: row.price_tinybar,
    payToAccount: row.pay_to_account,
    inputSchema: JSON.parse(row.input_schema),
    outputExample: JSON.parse(row.output_example),
    createdAt: row.created_at,
    calls: row.calls ?? 0,
    earnedTinybar: row.earned_tinybar ?? 0,
});

// Earnings are derived from the `calls` ledger rather than denormalised onto
// the listing, so the number on screen can never drift from the on-chain record.
const SELECT_LISTING = `
  SELECT l.*,
         COUNT(c.id)                AS calls,
         COALESCE(SUM(c.tinybar),0) AS earned_tinybar
  FROM listings l
  LEFT JOIN calls c ON c.slug = l.slug
`;

export class MarketplaceStore {
    private readonly db: DatabaseSyncType;

    constructor(path: string) {
        if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
        this.db = new DatabaseSync(path);
        this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS listings (
        slug           TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        description    TEXT NOT NULL,
        tags           TEXT NOT NULL DEFAULT '[]',
        upstream_url   TEXT NOT NULL,
        price_tinybar  INTEGER NOT NULL,
        pay_to_account TEXT NOT NULL,
        input_schema   TEXT NOT NULL DEFAULT '{}',
        output_example TEXT NOT NULL DEFAULT 'null',
        owner_token    TEXT NOT NULL,
        created_at     TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS calls (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        slug       TEXT NOT NULL,
        tinybar    INTEGER NOT NULL,
        tx_id      TEXT NOT NULL,
        payer      TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_calls_slug ON calls(slug);
      CREATE INDEX IF NOT EXISTS idx_calls_created ON calls(created_at DESC);
    `);
    }

    list(): PublicListing[] {
        const rows = this.db
            .prepare(`${SELECT_LISTING} GROUP BY l.slug ORDER BY l.created_at DESC`)
            .all() as unknown as ListingRow[];
        return rows.map(toPublic);
    }

    get(slug: string): PublicListing | undefined {
        const row = this.db
            .prepare(`${SELECT_LISTING} WHERE l.slug = ? GROUP BY l.slug`)
            .get(slug) as unknown as ListingRow | undefined;
        return row ? toPublic(row) : undefined;
    }

    /** Free-text over name/description/tags, plus an optional exact tag filter. */
    search(query?: string, tag?: string): PublicListing[] {
        const q = query?.trim().toLowerCase();
        return this.list().filter((l) => {
            if (tag && !l.tags.includes(tag.toLowerCase())) return false;
            if (!q) return true;
            const haystack = `${l.name} ${l.description} ${l.tags.join(" ")}`.toLowerCase();
            return haystack.includes(q);
        });
    }

    insert(listing: Listing, ownerToken: string): void {
        this.db
            .prepare(
                `INSERT INTO listings
           (slug, name, description, tags, upstream_url, price_tinybar,
            pay_to_account, input_schema, output_example, owner_token, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                listing.slug,
                listing.name,
                listing.description,
                JSON.stringify(listing.tags),
                listing.upstreamUrl,
                listing.priceTinybar,
                listing.payToAccount,
                JSON.stringify(listing.inputSchema),
                JSON.stringify(listing.outputExample ?? null),
                ownerToken,
                listing.createdAt,
            );
    }

    ownerTokenFor(slug: string): string | undefined {
        const row = this.db
            .prepare(`SELECT owner_token FROM listings WHERE slug = ?`)
            .get(slug) as { owner_token: string } | undefined;
        return row?.owner_token;
    }

    update(slug: string, patch: Partial<Listing>): void {
        const columns: Record<string, string> = {
            name: "name",
            description: "description",
            upstreamUrl: "upstream_url",
            priceTinybar: "price_tinybar",
            payToAccount: "pay_to_account",
        };
        const sets: string[] = [];
        const values: (string | number)[] = [];
        for (const [key, column] of Object.entries(columns)) {
            const value = patch[key as keyof Listing];
            if (value === undefined) continue;
            sets.push(`${column} = ?`);
            values.push(value as string | number);
        }
        if (patch.tags !== undefined) {
            sets.push("tags = ?");
            values.push(JSON.stringify(patch.tags));
        }
        if (patch.inputSchema !== undefined) {
            sets.push("input_schema = ?");
            values.push(JSON.stringify(patch.inputSchema));
        }
        if (sets.length === 0) return;
        values.push(slug);
        this.db.prepare(`UPDATE listings SET ${sets.join(", ")} WHERE slug = ?`).run(...values);
    }

    /** Records a settled payment. This ledger is what the activity feed and earnings read from. */
    recordCall(call: Omit<PaidCall, "id" | "createdAt">): void {
        this.db
            .prepare(
                `INSERT INTO calls (slug, tinybar, tx_id, payer, created_at) VALUES (?, ?, ?, ?, ?)`,
            )
            .run(call.slug, call.tinybar, call.txId, call.payer, new Date().toISOString());
    }

    recentCalls(limit = 50): PaidCall[] {
        const rows = this.db
            .prepare(
                `SELECT id, slug, tinybar, tx_id, payer, created_at
         FROM calls ORDER BY id DESC LIMIT ?`,
            )
            .all(limit) as unknown as Array<{
            id: number;
            slug: string;
            tinybar: number;
            tx_id: string;
            payer: string;
            created_at: string;
        }>;
        return rows.map((r) => ({
            id: r.id,
            slug: r.slug,
            tinybar: r.tinybar,
            txId: r.tx_id,
            payer: r.payer,
            createdAt: r.created_at,
        }));
    }

    close(): void {
        this.db.close();
    }
}
