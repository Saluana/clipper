import { createHash } from 'crypto';
import type {
    AsrArtifactsRepository,
    AsrArtifactRow,
    AsrJobsRepository,
} from '@clipper/data';
import type { QueueAdapter } from '@clipper/queue';

export interface AsrFacadeDeps {
    asrJobs: AsrJobsRepository;
    asrArtifacts?: AsrArtifactsRepository;
    queue?: QueueAdapter; // optional for now; Task 5 will formalize ASR topic
}

export interface AsrRequest {
    localPath: string; // required: scratch media file to hash & transcribe
    clipJobId?: string;
    sourceType?: string; // upload | youtube | internal (default internal)
    sourceKey?: string; // optional storage key
    modelVersion?: string; // default from env or whisper-large-v3-turbo
    languageHint?: string; // 'auto' or ISO 639-1
}

export interface AsrRequestResult {
    asrJobId: string;
    status: 'reused' | 'queued';
    artifacts?: AsrArtifactRow[];
    mediaHash: string;
    modelVersion: string;
}

export class AsrFacade {
    constructor(private readonly deps: AsrFacadeDeps) {}

    async request(req: AsrRequest): Promise<AsrRequestResult> {
        const modelVersion =
            req.modelVersion ||
            process.env.GROQ_MODEL ||
            'whisper-large-v3-turbo';
        const mediaHash = await sha256File(req.localPath);

        // Try reuse shortcut
        const reusable = await this.deps.asrJobs.getReusable(
            mediaHash,
            modelVersion
        );
        if (reusable) {
            return {
                asrJobId: reusable.id,
                status: 'reused',
                artifacts: reusable.artifacts,
                mediaHash,
                modelVersion,
            };
        }

        // Create a new ASR job row (queued)
        const id = crypto.randomUUID();
        await this.deps.asrJobs.create({
            id,
            clipJobId: req.clipJobId,
            sourceType: req.sourceType || 'internal',
            sourceKey: req.sourceKey,
            mediaHash,
            modelVersion,
            languageHint: req.languageHint,
            status: 'queued',
        });

        // Fire-and-forget enqueue (Task 5 will add dedicated ASR queue/topic)
        if (this.deps.queue) {
            try {
                await this.deps.queue.publish({
                    jobId: id,
                    priority: 'normal',
                });
            } catch (e) {
                // Non-fatal here; job remains queued for a future publisher
            }
        }

        return { asrJobId: id, status: 'queued', mediaHash, modelVersion };
    }
}

async function sha256File(filePath: string): Promise<string> {
    const hasher = createHash('sha256');
    const file = Bun.file(filePath);
    const stream = file.stream();
    for await (const chunk of stream as any) {
        hasher.update(chunk);
    }
    return hasher.digest('hex');
}
