import type { JobStatus } from '@clipper/contracts';
import { ServiceError } from './errors';

export type Transition = {
    from: JobStatus;
    to: JobStatus;
    at: string;
    reason?: string;
};

const allowed: Record<JobStatus, JobStatus[]> = {
    queued: ['processing'],
    processing: ['done', 'failed'],
    done: [],
    failed: [],
};

export function transition(
    current: JobStatus,
    to: JobStatus,
    reason?: string
): Transition {
    if (current === to && (to === 'done' || to === 'failed')) {
        return { from: current, to, at: new Date().toISOString(), reason };
    }
    const next = allowed[current] || [];
    if (!next.includes(to)) {
        throw new ServiceError(
            'INVALID_STATE',
            `Invalid transition ${current} -> ${to}`
        );
    }
    return { from: current, to, at: new Date().toISOString(), reason };
}
