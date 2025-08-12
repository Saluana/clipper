import type { JobStatus } from '@clipper/contracts';
import { desc, eq } from 'drizzle-orm';

export interface JobRow {
    id: string;
    status: JobStatus;
    progress: number;
    sourceType: 'upload' | 'youtube';
    sourceKey?: string;
    sourceUrl?: string;
    startSec: number;
    endSec: number;
    withSubtitles: boolean;
    burnSubtitles: boolean;
    subtitleLang?: string;
    resultVideoKey?: string;
    resultSrtKey?: string;
    errorCode?: string;
    errorMessage?: string;
    createdAt: string;
    updatedAt: string;
    expiresAt?: string;
    lastHeartbeatAt?: string;
}

export interface JobEvent {
    jobId: string;
    ts: string;
    type: string;
    data?: Record<string, unknown>;
}

export interface JobsRepository {
    create(row: Omit<JobRow, 'createdAt' | 'updatedAt'>): Promise<JobRow>;
    get(id: string): Promise<JobRow | null>;
    update(id: string, patch: Partial<JobRow>): Promise<JobRow>;
    listByStatus(
        status: JobStatus,
        limit?: number,
        offset?: number
    ): Promise<JobRow[]>;
    transition(
        id: string,
        next: JobStatus,
        event?: { type?: string; data?: Record<string, unknown> }
    ): Promise<JobRow>;
}

export interface JobEventsRepository {
    add(evt: JobEvent): Promise<void>;
    list(jobId: string, limit?: number, offset?: number): Promise<JobEvent[]>;
}

// --- ASR (Automatic Speech Recognition) domain types ---
export type AsrJobStatus = 'queued' | 'processing' | 'done' | 'failed';

export interface AsrJobRow {
    id: string;
    clipJobId?: string;
    sourceType: string; // upload | youtube | internal
    sourceKey?: string;
    mediaHash: string;
    modelVersion: string;
    languageHint?: string;
    detectedLanguage?: string;
    durationSec?: number;
    status: AsrJobStatus;
    errorCode?: string;
    errorMessage?: string;
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
    expiresAt?: string;
}

export interface AsrArtifactRow {
    asrJobId: string;
    kind: 'srt' | 'text' | 'json';
    storageKey: string;
    sizeBytes?: number;
    createdAt: string;
}

export interface AsrJobsRepository {
    create(
        row: Omit<AsrJobRow, 'createdAt' | 'updatedAt' | 'status'> &
            Partial<Pick<AsrJobRow, 'status'>>
    ): Promise<AsrJobRow>;
    get(id: string): Promise<AsrJobRow | null>;
    getReusable(
        mediaHash: string,
        modelVersion: string
    ): Promise<(AsrJobRow & { artifacts: AsrArtifactRow[] }) | null>;
    patch(id: string, patch: Partial<AsrJobRow>): Promise<AsrJobRow>;
}

export interface AsrArtifactsRepository {
    put(artifact: AsrArtifactRow): Promise<void>;
    list(asrJobId: string): Promise<AsrArtifactRow[]>;
}

// Minimal in-memory impl to wire API/worker until DB is added
export class InMemoryJobsRepo implements JobsRepository {
    private map = new Map<string, JobRow>();
    async create(
        row: Omit<JobRow, 'createdAt' | 'updatedAt'>
    ): Promise<JobRow> {
        const now = new Date().toISOString();
        const rec: JobRow = { ...row, createdAt: now, updatedAt: now };
        this.map.set(rec.id, rec);
        return rec;
    }
    async get(id: string) {
        return this.map.get(id) ?? null;
    }
    async update(id: string, patch: Partial<JobRow>): Promise<JobRow> {
        const cur = this.map.get(id);
        if (!cur) throw new Error('NOT_FOUND');
        const next = {
            ...cur,
            ...patch,
            updatedAt: new Date().toISOString(),
        } as JobRow;
        this.map.set(id, next);
        return next;
    }
    async listByStatus(
        status: JobStatus,
        limit = 50,
        offset = 0
    ): Promise<JobRow[]> {
        return Array.from(this.map.values())
            .filter((r) => r.status === status)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .slice(offset, offset + limit);
    }
    async transition(
        id: string,
        next: JobStatus,
        event?: { type?: string; data?: Record<string, unknown> }
    ): Promise<JobRow> {
        const cur = await this.get(id);
        if (!cur) throw new Error('NOT_FOUND');
        const updated = await this.update(id, { status: next });
        // no-op event store here; handled by InMemoryJobEventsRepo
        return updated;
    }
}

export class InMemoryJobEventsRepo implements JobEventsRepository {
    private events: JobEvent[] = [];
    async add(evt: JobEvent): Promise<void> {
        this.events.push(evt);
    }
    async listRecent(jobId: string, limit = 10) {
        return this.events
            .filter((e) => e.jobId === jobId)
            .sort((a, b) => a.ts.localeCompare(b.ts))
            .slice(0, limit);
    }
    async list(jobId: string, limit = 100, offset = 0): Promise<JobEvent[]> {
        return this.events
            .filter((e) => e.jobId === jobId)
            .sort((a, b) => a.ts.localeCompare(b.ts))
            .slice(offset, offset + limit);
    }
}

// (If a DrizzleJobEventsRepo is defined elsewhere, ensure it has listRecent; placeholder below if needed.)
