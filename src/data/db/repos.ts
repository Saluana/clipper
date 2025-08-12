import { desc, eq, and } from 'drizzle-orm';
import { createDb } from './connection';
import { jobEvents, jobs, asrJobs, asrArtifacts } from './schema';
import type { JobStatus } from '@clipper/contracts';
import { createLogger, noopMetrics, MetricsRegistry } from '../../common/index';
import type {
    JobEvent as RepoJobEvent,
    JobRow,
    JobEventsRepository,
    JobsRepository,
} from '../repo';
import type {
    AsrJobRow,
    AsrArtifactRow,
    AsrJobsRepository,
    AsrArtifactsRepository,
} from '../repo';

export class DrizzleJobsRepo implements JobsRepository {
    private readonly logger = createLogger('info').with({ comp: 'jobsRepo' });
    constructor(
        private readonly db = createDb(),
        private readonly metrics: MetricsRegistry = noopMetrics
    ) {}

    async create(
        row: Omit<JobRow, 'createdAt' | 'updatedAt'>
    ): Promise<JobRow> {
        const start = Date.now();
        const [rec] = await this.db
            .insert(jobs)
            .values({
                id: row.id,
                status: row.status,
                progress: row.progress,
                sourceType: row.sourceType,
                sourceKey: row.sourceKey,
                sourceUrl: row.sourceUrl,
                startSec: row.startSec,
                endSec: row.endSec,
                withSubtitles: row.withSubtitles,
                burnSubtitles: row.burnSubtitles,
                subtitleLang: row.subtitleLang,
                resultVideoKey: row.resultVideoKey,
                resultSrtKey: row.resultSrtKey,
                errorCode: row.errorCode,
                errorMessage: row.errorMessage,
                expiresAt: row.expiresAt ? new Date(row.expiresAt) : null,
            })
            .returning();
        const out = toJobRow(rec);
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'jobs.create',
        });
        // Job lifecycle metric (Req 3.1)
        try {
            (this.metrics as any).inc?.('jobs.created_total');
        } catch {}
        this.logger.info('job created', { jobId: out.id });
        return out;
    }

    async get(id: string): Promise<JobRow | null> {
        const start = Date.now();
        const [rec] = await this.db
            .select()
            .from(jobs)
            .where(eq(jobs.id, id))
            .limit(1);
        const out = rec ? toJobRow(rec) : null;
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'jobs.get',
        });
        return out;
    }

    async update(id: string, patch: Partial<JobRow>): Promise<JobRow> {
        const start = Date.now();
        // Fetch current status for transition metric & latency
        let current: any = null;
        try {
            const [cur] = await this.db
                .select({
                    id: jobs.id,
                    status: jobs.status,
                    createdAt: jobs.createdAt,
                })
                .from(jobs)
                .where(eq(jobs.id, id))
                .limit(1);
            current = cur;
        } catch {}
        const [rec] = await this.db
            .update(jobs)
            .set(toJobsPatch(patch))
            .where(eq(jobs.id, id))
            .returning();
        if (!rec) throw new Error('NOT_FOUND');
        const row = toJobRow(rec);
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'jobs.update',
        });
        // Status transition metric (Req 3.2)
        try {
            if (current && patch.status && patch.status !== current.status) {
                (this.metrics as any).inc?.('jobs.status_transition_total', 1, {
                    from: current.status,
                    to: patch.status,
                });
                // Total latency on terminal states (Req 3.3)
                if (
                    (patch.status === 'done' || patch.status === 'failed') &&
                    current.createdAt
                ) {
                    const createdAt = new Date(
                        current.createdAt as any
                    ).getTime();
                    const latency = Date.now() - createdAt;
                    (this.metrics as any).observe?.(
                        'jobs.total_latency_ms',
                        latency
                    );
                }
            }
        } catch {}
        this.logger.info('job updated', { jobId: row.id });
        return row;
    }

    async listByStatus(
        status: JobStatus,
        limit = 50,
        offset = 0
    ): Promise<JobRow[]> {
        const start = Date.now();
        const rows = await this.db
            .select()
            .from(jobs)
            .where(eq(jobs.status, status))
            .orderBy(desc(jobs.createdAt))
            .limit(limit)
            .offset(offset);
        const out = rows.map(toJobRow);
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'jobs.listByStatus',
        });
        return out;
    }

    async transition(
        id: string,
        next: JobStatus,
        event?: { type?: string; data?: Record<string, unknown> }
    ): Promise<JobRow> {
        const start = Date.now();
        const res = await this.db.transaction(async (tx) => {
            const [updated] = await tx
                .update(jobs)
                .set({ status: next, updatedAt: new Date() })
                .where(eq(jobs.id, id))
                .returning();
            if (!updated) throw new Error('NOT_FOUND');

            if (event) {
                await tx.insert(jobEvents).values({
                    jobId: id,
                    type: event.type ?? `status:${next}`,
                    data: event.data ?? null,
                });
            }
            return toJobRow(updated);
        });
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'jobs.transition',
        });
        this.logger.info('job transitioned', { jobId: id, next });
        return res;
    }
}

export class DrizzleJobEventsRepo implements JobEventsRepository {
    constructor(
        private readonly db = createDb(),
        private readonly metrics: MetricsRegistry = noopMetrics
    ) {}

    async add(evt: RepoJobEvent): Promise<void> {
        const start = Date.now();
        try {
            await this.db.insert(jobEvents).values({
                jobId: evt.jobId,
                ts: new Date(evt.ts),
                type: evt.type,
                data: evt.data ?? null,
            });
        } catch (e) {
            // Increment persistence failure metric (Req 8.1)
            try {
                (this.metrics as any).inc?.('events.persist_failures_total');
            } catch {}
            throw e;
        } finally {
            this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
                op: 'events.add',
            });
        }
    }

    async list(
        jobId: string,
        limit = 100,
        offset = 0
    ): Promise<RepoJobEvent[]> {
        const start = Date.now();
        const rows = await this.db
            .select()
            .from(jobEvents)
            .where(eq(jobEvents.jobId, jobId))
            .orderBy(desc(jobEvents.ts))
            .limit(limit)
            .offset(offset);
        const out = rows.map((r) => ({
            jobId: r.jobId,
            ts: r.ts.toISOString(),
            type: r.type,
            data: (r.data as Record<string, unknown> | null) ?? undefined,
        }));
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'events.list',
        });
        return out;
    }
}

// ASR Repositories
export class DrizzleAsrJobsRepo implements AsrJobsRepository {
    private readonly logger = createLogger('info').with({
        comp: 'asrJobsRepo',
    });
    constructor(
        private readonly db = createDb(),
        private readonly metrics: MetricsRegistry = noopMetrics
    ) {}

    async create(
        row: Omit<AsrJobRow, 'createdAt' | 'updatedAt' | 'status'> &
            Partial<Pick<AsrJobRow, 'status'>>
    ): Promise<AsrJobRow> {
        const start = Date.now();
        const [rec] = await this.db
            .insert(asrJobs)
            .values({
                id: row.id,
                clipJobId: row.clipJobId,
                sourceType: row.sourceType,
                sourceKey: row.sourceKey,
                mediaHash: row.mediaHash,
                modelVersion: row.modelVersion,
                languageHint: row.languageHint,
                detectedLanguage: row.detectedLanguage,
                durationSec: row.durationSec,
                status: row.status ?? 'queued',
                errorCode: row.errorCode,
                errorMessage: row.errorMessage,
                completedAt: row.completedAt ? new Date(row.completedAt) : null,
                expiresAt: row.expiresAt ? new Date(row.expiresAt) : null,
            })
            .returning();
        const out = toAsrJobRow(rec);
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'asrJobs.create',
        });
        this.logger.info('asr job created', { asrJobId: out.id });
        return out;
    }

    async get(id: string): Promise<AsrJobRow | null> {
        const start = Date.now();
        const [rec] = await this.db
            .select()
            .from(asrJobs)
            .where(eq(asrJobs.id, id))
            .limit(1);
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'asrJobs.get',
        });
        return rec ? toAsrJobRow(rec) : null;
    }

    async getReusable(
        mediaHash: string,
        modelVersion: string
    ): Promise<(AsrJobRow & { artifacts: AsrArtifactRow[] }) | null> {
        const start = Date.now();
        const [rec] = await this.db
            .select()
            .from(asrJobs)
            .where(
                and(
                    eq(asrJobs.mediaHash, mediaHash),
                    eq(asrJobs.modelVersion, modelVersion),
                    eq(asrJobs.status, 'done')
                )
            )
            .limit(1);
        if (!rec) return null;
        const artifacts = await this.db
            .select()
            .from(asrArtifacts)
            .where(eq(asrArtifacts.asrJobId, rec.id));
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'asrJobs.getReusable',
        });
        return {
            ...toAsrJobRow(rec),
            artifacts: artifacts.map(toAsrArtifactRow),
        };
    }

    async patch(id: string, patch: Partial<AsrJobRow>): Promise<AsrJobRow> {
        const start = Date.now();
        const [rec] = await this.db
            .update(asrJobs)
            .set(toAsrJobsPatch(patch))
            .where(eq(asrJobs.id, id))
            .returning();
        if (!rec) throw new Error('NOT_FOUND');
        const row = toAsrJobRow(rec);
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'asrJobs.patch',
        });
        this.logger.info('asr job patched', { asrJobId: row.id });
        return row;
    }
}

export class DrizzleAsrArtifactsRepo implements AsrArtifactsRepository {
    constructor(
        private readonly db = createDb(),
        private readonly metrics: MetricsRegistry = noopMetrics
    ) {}

    async put(artifact: AsrArtifactRow): Promise<void> {
        const start = Date.now();
        await this.db
            .insert(asrArtifacts)
            .values({
                asrJobId: artifact.asrJobId,
                kind: artifact.kind,
                storageKey: artifact.storageKey,
                sizeBytes: artifact.sizeBytes,
            })
            .onConflictDoUpdate({
                target: [asrArtifacts.asrJobId, asrArtifacts.kind],
                set: {
                    storageKey: artifact.storageKey,
                    sizeBytes: artifact.sizeBytes,
                },
            });
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'asrArtifacts.put',
        });
    }

    async list(asrJobId: string): Promise<AsrArtifactRow[]> {
        const start = Date.now();
        const rows = await this.db
            .select()
            .from(asrArtifacts)
            .where(eq(asrArtifacts.asrJobId, asrJobId));
        this.metrics.observe('repo.op.duration_ms', Date.now() - start, {
            op: 'asrArtifacts.list',
        });
        return rows.map(toAsrArtifactRow);
    }
}

function toJobRow(j: any): JobRow {
    return {
        id: j.id,
        status: j.status,
        progress: j.progress,
        sourceType: j.sourceType,
        sourceKey: j.sourceKey ?? undefined,
        sourceUrl: j.sourceUrl ?? undefined,
        startSec: j.startSec,
        endSec: j.endSec,
        withSubtitles: j.withSubtitles,
        burnSubtitles: j.burnSubtitles,
        subtitleLang: j.subtitleLang ?? undefined,
        resultVideoKey: j.resultVideoKey ?? undefined,
        resultSrtKey: j.resultSrtKey ?? undefined,
        errorCode: j.errorCode ?? undefined,
        errorMessage: j.errorMessage ?? undefined,
        createdAt: j.createdAt.toISOString(),
        updatedAt: j.updatedAt.toISOString(),
        expiresAt: j.expiresAt ? j.expiresAt.toISOString() : undefined,
        lastHeartbeatAt: j.lastHeartbeatAt
            ? j.lastHeartbeatAt.toISOString()
            : undefined,
    };
}

function toJobsPatch(patch: Partial<JobRow>) {
    const out: any = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (k === 'expiresAt' && v) out[k] = new Date(v as string);
        else if (k === 'lastHeartbeatAt' && v) out[k] = new Date(v as string);
        else out[k] = v as any;
    }
    return out;
}

function toAsrJobRow(j: any): AsrJobRow {
    return {
        id: j.id,
        clipJobId: j.clipJobId ?? undefined,
        sourceType: j.sourceType,
        sourceKey: j.sourceKey ?? undefined,
        mediaHash: j.mediaHash,
        modelVersion: j.modelVersion,
        languageHint: j.languageHint ?? undefined,
        detectedLanguage: j.detectedLanguage ?? undefined,
        durationSec: j.durationSec ?? undefined,
        status: j.status,
        errorCode: j.errorCode ?? undefined,
        errorMessage: j.errorMessage ?? undefined,
        createdAt: j.createdAt.toISOString(),
        updatedAt: j.updatedAt.toISOString(),
        completedAt: j.completedAt ? j.completedAt.toISOString() : undefined,
        expiresAt: j.expiresAt ? j.expiresAt.toISOString() : undefined,
    };
}

function toAsrJobsPatch(patch: Partial<AsrJobRow>) {
    const out: any = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        if (k.endsWith('At') && v) out[k] = new Date(v as string);
        else out[k] = v as any;
    }
    return out;
}

function toAsrArtifactRow(a: any): AsrArtifactRow {
    return {
        asrJobId: a.asrJobId,
        kind: a.kind,
        storageKey: a.storageKey,
        sizeBytes: a.sizeBytes ?? undefined,
        createdAt: a.createdAt.toISOString(),
    };
}
