import { readEnv } from '@clipper/common';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export async function measureDirSizeBytes(dir: string): Promise<number> {
    try {
        const s = await stat(dir);
        if (!s.isDirectory()) return s.size;
    } catch {
        return 0;
    }
    let total = 0;
    const stack: string[] = [dir];
    while (stack.length) {
        const d = stack.pop()!;
        let ents: any[] = [];
        try {
            ents = await readdir(d, { withFileTypes: true } as any);
        } catch {
            continue;
        }
        for (const ent of ents) {
            const p = join(d, (ent as any).name);
            try {
                if ((ent as any).isDirectory?.()) stack.push(p);
                else {
                    const s = await stat(p);
                    total += s.size;
                }
            } catch {}
        }
    }
    return total;
}

export async function removeDirRecursive(dir: string): Promise<void> {
    try {
        await rm(dir, { recursive: true, force: true } as any);
    } catch {}
}

export async function cleanupScratch(dir: string, success: boolean) {
    if (!dir) return { deleted: false, sizeBytes: 0 } as const;
    const keepOnSuccess =
        String(readEnv('KEEP_SCRATCH_ON_SUCCESS') || '0') === '1';
    const keepOnFailure = String(readEnv('KEEP_FAILED') || '0') === '1';
    if (success) {
        if (keepOnSuccess) {
            return {
                deleted: false,
                sizeBytes: await measureDirSizeBytes(dir),
            } as const;
        }
        await removeDirRecursive(dir);
        return { deleted: true, sizeBytes: 0 } as const;
    }
    if (keepOnFailure) {
        return {
            deleted: false,
            sizeBytes: await measureDirSizeBytes(dir),
        } as const;
    }
    await removeDirRecursive(dir);
    return { deleted: true, sizeBytes: 0 } as const;
}

export interface StorageLike {
    remove(key: string): Promise<void>;
}

export async function cleanupStorageOnFailure(
    storage: StorageLike | null,
    key: string | null
) {
    const keepOnFailure = String(readEnv('KEEP_FAILED') || '0') === '1';
    if (!storage || !key || keepOnFailure) return false;
    try {
        await storage.remove(key);
        return true;
    } catch {
        return false;
    }
}
