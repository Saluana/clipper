artifact_id: 93191111-1111-4111-b111-111111111111
content_type: text/markdown
title: tasks.md

# FFmpeg Service Implementation Tasks

This document breaks down the work required to implement the FFmpeg Service (Clipper) as described in the requirements and design documents.

### ✅ Task Checklist

-   [x] **1. Create Project Structure**

    -   [x] Create the main directory: `src/ffmpeg`.
    -   [x] Create the following files:
        -   `src/ffmpeg/index.ts`
        -   `src/ffmpeg/types.ts`
        -   `src/ffmpeg/clipper.ts`
        -   `src/ffmpeg/progress.ts`

-   [x] **2. Implement Core Types**

    -   **File**: `src/ffmpeg/types.ts`
    -   [x] Define and export the `ClipResult`, `ClipArgs`, and `Clipper` interfaces as specified in the design document.
    -   **Requirements**: 1.1, 2.1

-   [x] **3. Implement Progress Parser**

    -   **File**: `src/ffmpeg/progress.ts`
    -   [x] Implement the `parseFfmpegProgress` async generator function.
    -   [x] It accepts a `ReadableStream` and `totalDurationSec`.
    -   [x] It parses `out_time_ms=` lines and yields monotonic percentage values.
    -   [x] It yields `100` upon completion.
    -   **Requirements**: 2.1, 2.2, 2.3

-   [x] **4. Implement the Clipper Service**

    -   **File**: `src/ffmpeg/clipper.ts`
    -   [x] Create the `BunClipper` class implementing the `Clipper` interface.
    -   [x] Implement the `clip` method.
    -   [ ] **4.1. Stream-Copy Logic**:
    -   [x] Use `Bun.spawn` to execute the `ffmpeg` stream-copy command.
    -   [x] Pipe the process's progress stream to the `parseFfmpegProgress` utility.
    -   [x] Check the exit code. If successful, return the local path and progress stream.
    -   [ ] **4.2. Re-encode Fallback Logic**:
    -   [x] If the stream-copy process fails (non-zero exit code), log the error and trigger the re-encode command.
    -   [x] Execute the `ffmpeg` re-encode command using `Bun.spawn`.
    -   [x] Pipe its progress stream to the parser.
    -   [x] If this process also fails, throw a `ServiceError`.
    -   [ ] **4.3. File Management**:
    -   [x] Ensure the output directory inside `SCRATCH_DIR` is created before spawning FFmpeg.
    -   **Requirements**: 1.1, 1.2, 1.3, 1.4, 1.5

-   [x] **5. Integrate Clipper into Worker**

    -   **File**: `src/worker/index.ts`
    -   [x] Import and instantiate `BunClipper`.
    -   [x] In the `queue.consume` handler, after resolving the source file:
        -   [x] Call `clipper.clip()`.
        -   [x] Use a `for await...of` loop to consume the `progress$` stream.
        -   [x] Inside the loop, call `jobs.updateProgress()` and `events.add()`.
        -   [x] On successful completion, upload the resulting clip using `StorageRepo`.
        -   [x] Update the job status to `done` and set `resultVideoKey`.
        -   [x] Implement `try...catch` around the clipping logic to handle `ServiceError` and mark the job as `failed`.
        -   [x] Add a `finally` block to ensure temporary files are cleaned up.
    -   **Requirements**: 3.1, 3.2, 3.3, 3.4, 3.5

-   [x] **6. Add to Barrel File**

    -   **File**: `src/ffmpeg/index.ts`
    -   [x] Export all public interfaces and the `BunClipper` class.

-   [x] **7. (Optional but Recommended) Integration Testing**

    -   [x] Create `src/ffmpeg/ffmpeg.integration.test.ts`.
    -   [x] Add a test case for a successful stream copy.
    -   [x] Add a test to verify progress reporting.

-   [x] **8. Documentation**
    -   [x] Add JSDoc comments to all public functions and interfaces.
    -   [x] Update the main `README.md` or other relevant docs if necessary to mention that `ffmpeg` is now a required dependency.
