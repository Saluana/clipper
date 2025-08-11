artifact_id: 6a31b93c-48f2-445d-813a-11811111818d
content_type: text/markdown
title: design.md

# FFmpeg Service (Clipper) Technical Design

## 1. Overview

The FFmpeg Service, also known as the "Clipper," is a core component responsible for executing video clipping operations. It is designed for efficiency and resilience, prioritizing a high-speed stream-copy approach while providing a reliable re-encoding fallback. The service is a self-contained module that will be consumed by the Worker Runtime.

## 2. Architecture

The service will be encapsulated within the `src/ffmpeg` directory. It exposes a single `Clipper` interface, which the worker will use.

### System Flow

```mermaid
graph TD
    A[Worker Runtime] -- clip(args) --> B{Clipper Service};
    B -- 1. Attempt Stream Copy --> C[FFmpeg Process (copy)];
    C -- stderr --> D[Progress Parser];
    D -- progress % --> A;
    C -- exit code --> B;
    B -- Success --> E[Return Clip Path];
    B -- Failure --> F{2. Attempt Re-encode};
    F -- ffmpeg spawn --> G[FFmpeg Process (re-encode)];
    G -- stderr --> D;
    G -- exit code --> F;
    F -- Success --> E;
    F -- Failure --> H[Throw ServiceError];
    E --> A;
    H --> A;
```

### Core Components

-   **`BunClipper`**: The primary implementation of the `Clipper` interface. It orchestrates the FFmpeg process execution, including the fallback logic.
-   **`ProgressParser`**: A utility that consumes the `stderr` stream from an FFmpeg process and yields standardized progress percentages.

## 3. Components and Interfaces

### TypeScript Interfaces

These interfaces define the contract for the service and its data structures.

```typescript
// src/ffmpeg/types.ts

/** Result from a successful clip operation. */
export interface ClipResult {
    /** The local filesystem path to the generated clip. */
    localPath: string;
    /** An async iterable that yields progress from 0 to 100. */
    progress$: AsyncIterable<number>;
}

/** Arguments for the clip method. */
export interface ClipArgs {
    /** The local filesystem path to the source video. */
    input: string;
    /** The start time of the clip in seconds. */
    startSec: number;
    /** The end time of the clip in seconds. */
    endSec: number;
    /** The unique ID of the job for logging and temp file naming. */
    jobId: string;
}

/** The main interface for the FFmpeg clipping service. */
export interface Clipper {
    clip(args: ClipArgs): Promise<ClipResult>;
}
```

## 4. FFmpeg Execution Strategy

The service will use `Bun.spawn` for non-blocking execution of FFmpeg.

### Primary Strategy: Stream Copy

This is the fastest method as it avoids re-encoding video and audio streams.

-   **Command**: `ffmpeg -y -hide_banner -progress pipe:1 -ss <start> -i <input> -to <end> -c copy -movflags +faststart <output.mp4>`
-   **`-progress pipe:1`**: Sends machine-readable progress to `stdout` (or another file descriptor), which is easier to parse than the human-readable `stderr` logs.
-   **`-movflags +faststart`**: Crucial for web playback, moving the moov atom to the beginning of the file.

### Fallback Strategy: Re-encode

This is used if the stream copy fails. It is more CPU-intensive but far more reliable.

-   **Command**: `ffmpeg -y -hide_banner -progress pipe:1 -ss <start> -i <input> -to <end> -c:v libx264 -preset veryfast -c:a aac -movflags +faststart <output.mp4>`
-   **`-c:v libx264 -preset veryfast`**: A good balance of speed and quality for the video codec.
-   **`-c:a aac`**: A widely compatible audio codec.

## 5. Progress Parsing

The `ProgressParser` will be an `AsyncGenerator` that takes a `ReadableStream` and the total clip duration.

```typescript
// src/ffmpeg/progress.ts

export async function* parseFfmpegProgress(
    stream: ReadableStream<Uint8Array>,
    totalDurationSec: number
): AsyncIterable<number> {
    const reader = stream.getReader();
    const textDecoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += textDecoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // Keep the last partial line

        for (const line of lines) {
            if (line.startsWith('out_time_ms=')) {
                const ms = parseInt(line.split('=')[1]);
                const percent = Math.round(
                    (ms / 1_000_000 / totalDurationSec) * 100
                );
                yield Math.min(percent, 99); // Cap at 99 until process exits
            }
        }
    }
    yield 100; // Signal completion
}
```

## 6. Error Handling

-   **FFmpeg Process Errors**: If `Bun.spawn` returns a non-zero exit code, the service will throw a `ServiceError` with `code: 'FFMPEG_FAILED'`. The error message will include the exit code and any captured `stderr` output for diagnostics.
-   **File System Errors**: Errors creating directories or writing files will be caught and re-thrown as `ServiceError` with `code: 'FILESYSTEM_ERROR'`.
-   The worker is responsible for catching these errors and marking the job as `failed`.

## 7. Testing Strategy

-   **Unit Tests**:
    -   Test the `ProgressParser` with mock `ReadableStream` data containing sample FFmpeg progress output.
-   **Integration Tests (`ffmpeg.integration.test.ts`)**:
    -   Create a test that requires `ffmpeg` to be installed in the environment.
    -   Use a small, known video file (e.g., `test-assets/sample.mp4`).
    -   **Test Case 1**: Verify a successful stream-copy clip. Check the output file's existence and approximate duration.
    -   **Test Case 2**: (Optional) Craft a scenario that forces a re-encode and verify its success.
    -   **Test Case 3**: Verify that progress updates are emitted correctly during a clip operation.
