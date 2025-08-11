import { createDb } from './db/connection';
import { apiKeys } from './db/schema';
import { eq } from 'drizzle-orm';

export interface ApiKeyRecord {
    id: string;
    name: string;
    revoked: boolean;
    createdAt: string;
    lastUsedAt?: string;
}

export interface ApiKeysRepository {
    issue(name: string): Promise<{ id: string; name: string; token: string }>;
    verify(token: string): Promise<ApiKeyRecord | null>;
    revoke(id: string): Promise<void>;
}

function ensureBunPassword() {
    const bun: any = (globalThis as any).Bun;
    if (!bun?.password) {
        throw new Error('BUN_PASSWORD_UNAVAILABLE: Bun.password is required');
    }
    return bun.password as {
        hash: (pw: string | ArrayBufferView, opts?: any) => Promise<string>;
        verify: (
            pw: string | ArrayBufferView,
            hash: string
        ) => Promise<boolean>;
    };
}

function generateTokenParts() {
    const id = crypto.randomUUID();
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const secret = Buffer.from(bytes).toString('base64url');
    return { id, secret };
}

function packToken(id: string, secret: string) {
    return `ck_${id}_${secret}`;
}

function unpackToken(token: string): { id: string; secret: string } | null {
    if (!token.startsWith('ck_')) return null;
    const parts = token.split('_');
    if (parts.length < 3) return null;
    const id = parts[1]!;
    const secret = parts.slice(2).join('_');
    if (!id || !secret) return null;
    return { id, secret };
}

export class DrizzleApiKeysRepo implements ApiKeysRepository {
    constructor(private readonly db = createDb()) {}

    async issue(
        name: string
    ): Promise<{ id: string; name: string; token: string }> {
        const { id, secret } = generateTokenParts();
        const token = packToken(id, secret);
        const bunPwd = ensureBunPassword();
        const hash = await bunPwd.hash(secret);
        await this.db
            .insert(apiKeys)
            .values({ id, name, keyHash: hash, revoked: false });
        return { id, name, token };
    }

    async verify(token: string): Promise<ApiKeyRecord | null> {
        const parsed = unpackToken(token);
        if (!parsed) return null;
        const [rec] = await this.db
            .select()
            .from(apiKeys)
            .where(eq(apiKeys.id, parsed.id))
            .limit(1);
        if (!rec || rec.revoked) return null;
        const bunPwd = ensureBunPassword();
        const ok = await bunPwd.verify(parsed.secret, rec.keyHash);
        if (!ok) return null;
        await this.db
            .update(apiKeys)
            .set({ lastUsedAt: new Date() })
            .where(eq(apiKeys.id, rec.id));
        return {
            id: rec.id,
            name: rec.name,
            revoked: rec.revoked,
            createdAt: rec.createdAt.toISOString(),
            lastUsedAt: rec.lastUsedAt?.toISOString(),
        };
    }

    async revoke(id: string): Promise<void> {
        await this.db
            .update(apiKeys)
            .set({ revoked: true })
            .where(eq(apiKeys.id, id));
    }
}
