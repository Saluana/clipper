artifact_id: 24281813-d129-47b1-818d-351818641733
content_type: text/markdown
title: requirements.md

# FFmpeg Service Requirements

## Introduction

This document outlines the functional and non-functional requirements for the FFmpeg Service (Clipper). This service is responsible for creating video clips from a larger source video file based on specified start and end times. It must be fast, reliable, and provide feedback on its progress.

## 1. Core Clipping Functionality

### User Story

As a user of the platform, I want to request a video clip from a source file by providing start and end timecodes, so that I can get a smaller video containing only the segment I'm interested in.

### Acceptance Criteria

-   **WHEN** a clipping job is initiated with a valid source file, start time, and end time,
    **THEN** the service **SHALL** attempt to create the clip using a fast stream-copy method (`-c copy`).
-   **IF** the stream-copy method succeeds,
    **THEN** the output **SHALL** be a valid MP4 file containing the exact requested segment.
-   **IF** the stream-copy method fails for any reason (e.g., codec incompatibility, keyframe issues),
    **THEN** the service **SHALL** automatically attempt to create the clip by re-encoding it with a reliable codec (`libx264`).
-   **WHEN** the re-encode method is used,
    **THEN** the output **SHALL** be a valid MP4 file with the `-movflags +faststart` flag for web-friendliness.
-   **IF** both clipping methods fail,
    **THEN** the job **SHALL** be marked as `failed` with a clear error message indicating the cause.

## 2. Progress Reporting

### User Story

As a user waiting for a clip to be created, I want to see the progress of the operation, so that I know the system is working and can estimate the remaining time.

### Acceptance Criteria

-   **WHEN** the FFmpeg process is running (for either stream-copy or re-encode),
    **THEN** the service **SHALL** parse FFmpeg's `stderr` output to extract progress information.
-   **GIVEN** the total duration of the requested clip segment,
    **THEN** the service **SHALL** calculate the completion percentage based on the `out_time_ms` or `time=` value from FFmpeg's output.
-   **THEN** the service **SHALL** emit progress updates (as a percentage from 0 to 100) to the worker runtime.
-   **WHEN** the clip is successfully generated,
    **THEN** the final progress update **SHALL** be 100%.

## 3. Integration with Worker

### User Story

As a system architect, I want the FFmpeg service to be seamlessly integrated into the worker runtime, so that it can be invoked as part of the overall job processing pipeline.

### Acceptance Criteria

-   **GIVEN** a job that has successfully resolved a source video to a local file path,
    **THEN** the worker **SHALL** invoke the FFmpeg service with the correct arguments (input path, start/end seconds).
-   **WHILE** the FFmpeg service is running,
    **THEN** the worker **SHALL** receive progress updates and persist them to the `jobs` table.
-   **WHEN** the FFmpeg service successfully returns a local path to the final clip,
    **THEN** the worker **SHALL** upload this file to the results storage.
-   **WHEN** the upload is complete,
    **THEN** the worker **SHALL** update the job's status to `done` and record the `resultVideoKey`.
-   **AFTER** the job is complete (or has failed),
    **THEN** the worker **SHALL** ensure all temporary files (source and clip) are cleaned up from the local scratch directory.
