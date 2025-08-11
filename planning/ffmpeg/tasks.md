artifact_id: 93191111-1111-4111-b111-111111111111
content_type: text/markdown
title: tasks.md

# FFmpeg Service Implementation Tasks

This document breaks down the work required to implement the FFmpeg Service (Clipper) as described in the requirements and design documents.

### ✅ Task Checklist

-   [ ] **1. Create Project Structure**

    -   [ ] Create the main directory: `src/ffmpeg`.
    -   [ ] Create the following empty files:
        -   `src/ffmpeg/index.ts`
        -   `src/ffmpeg/types.ts`
        -   `src/ffmpeg/clipper.ts`
        -   `src/ffmpeg/progress.ts`

-   [ ] **2. Implement Core Types**

    -   **File**: `src/ffmpeg/types.ts`
    -   [ ] Define and export the `ClipResult`, `ClipArgs`, and `Clipper` interfaces as specified in the design document.
    -   **Requirements**: 1.1, 2.1

-   [ ] **3. Implement Progress Parser**

    -   **File**: `src/ffmpeg/progress.ts`
    -   [ ] Implement the `parseFfmpegProgress` async generator function.
    -   [ ] It should accept a `ReadableStream` and `totalDurationSec`.
    -   [ ] It should correctly parse `out_time_ms=` from the stream and yield a percentage.
    -   [ ] Ensure it yields `100` upon stream completion.
    -   **Requirements**: 2.1, 2.2, 2.3

-   [ ] **4. Implement the Clipper Service**

    -   **File**: `src/ffmpeg/clipper.ts`
    -   [ ] Create the `BunClipper` class implementing the `Clipper` interface.
    -   [ ] Implement the `clip` method.
    -   [ ] **4.1. Stream-Copy Logic**:
        -   [ ] Use `Bun.spawn` to execute the `ffmpeg` stream-copy command.
        -   [ ] Pipe the process's progress stream to the `parseFfmpegProgress` utility.
        -   [ ] Check the exit code. If successful, return the local path and progress stream.
    -   [ ] **4.2. Re-encode Fallback Logic**:
        -   [ ] If the stream-copy process fails (non-zero exit code), log the error and trigger the re-encode command.
        -   [ ] Execute the `ffmpeg` re-encode command using `Bun.spawn`.
        -   [ ] Pipe its progress stream to the parser.
        -   [ ] If this process also fails, throw a `ServiceError`.
    -   [ ] **4.3. File Management**:
        -   [ ] Ensure the output directory inside `SCRATCH_DIR` is created before spawning FFmpeg.
    -   **Requirements**: 1.1, 1.2, 1.3, 1.4, 1.5

-   [ ] **5. Integrate Clipper into Worker**

    -   **File**: `src/worker/index.ts`
    -   [ ] Import and instantiate `BunClipper`.
    -   [ ] In the `queue.consume` handler, after resolving the source file:
        -   [ ] Call `clipper.clip()`.
        -   [ ] Use a `for await...of` loop to consume the `progress$` stream.
        -   [ ] Inside the loop, call `jobs.updateProgress()` and `events.add()`.
        -   [ ] On successful completion, upload the resulting clip using `StorageRepo`.
        -   [ ] Update the job status to `done` and set `resultVideoKey`.
        -   [ ] Implement `try...catch` around the clipping logic to handle `ServiceError` and mark the job as `failed`.
        -   [ ] Add a `finally` block to ensure temporary files are cleaned up.
    -   **Requirements**: 3.1, 3.2, 3.3, 3.4, 3.5

-   [ ] **6. Add to Barrel File**

    -   **File**: `src/ffmpeg/index.ts`
    -   [ ] Export all public interfaces and the `BunClipper` class.

-   [ ] **7. (Optional but Recommended) Integration Testing**

    -   [ ] Create `src/ffmpeg/ffmpeg.integration.test.ts`.
    -   [ ] Add a test case for a successful stream copy.
    -   [ ] Add a test to verify progress reporting.

-   [ ] **8. Documentation**
    -   [ ] Add JSDoc comments to all public functions and interfaces.
    -   [ ] Update the main `README.md` or other relevant docs if necessary to mention that `ffmpeg` is now a required dependency.
