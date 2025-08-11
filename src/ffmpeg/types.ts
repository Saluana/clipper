/**
 * Types for the FFmpeg clipping service.
 */
export interface ClipResult {
    /** Local filesystem path to the generated clip file (mp4). */
    localPath: string;
    /** Async iterable emitting progress percentages (0..100). */
    progress$: AsyncIterable<number>;
}

export interface ClipArgs {
    /** Source local file path (must exist and be readable). */
    input: string;
    /** Inclusive start time in seconds. */
    startSec: number;
    /** Exclusive end time in seconds (must be > startSec). */
    endSec: number;
    /** Job id for logging / namespacing temp outputs. */
    jobId: string;
}

export interface Clipper {
    /** Execute a clip operation returning path + progress stream. */
    clip(args: ClipArgs): Promise<ClipResult>;
}
