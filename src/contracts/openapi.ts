// Optional OpenAPI generator without external libs (compatible with current stack)
import { readEnv } from '../common/env';

function buildSchemas() {
    const CreateJobInput = {
        type: 'object',
        properties: {
            sourceType: { type: 'string', enum: ['upload', 'youtube'] },
            youtubeUrl: { type: 'string', format: 'uri' },
            uploadKey: { type: 'string' },
            start: {
                type: 'string',
                pattern: '^\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?$',
            },
            end: {
                type: 'string',
                pattern: '^\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?$',
            },
            withSubtitles: { type: 'boolean', default: false },
            burnSubtitles: { type: 'boolean', default: false },
            subtitleLang: {
                oneOf: [
                    { type: 'string', enum: ['auto'] },
                    { type: 'string', minLength: 2 },
                ],
            },
        },
        required: ['sourceType', 'start', 'end'],
        additionalProperties: false,
    } as const;
    const JobRecord = {
        type: 'object',
        properties: {
            id: { type: 'string', format: 'uuid' },
            status: {
                type: 'string',
                enum: ['queued', 'processing', 'done', 'failed'],
            },
            progress: { type: 'integer', minimum: 0, maximum: 100 },
            resultVideoKey: { type: 'string' },
            resultVideoBurnedKey: { type: 'string' },
            resultSrtKey: { type: 'string' },
            error: { type: 'string' },
            expiresAt: { type: 'string' },
            createdAt: { type: 'string' },
            updatedAt: { type: 'string' },
        },
        required: [
            'id',
            'status',
            'progress',
            'expiresAt',
            'createdAt',
            'updatedAt',
        ],
    } as const;
    return { CreateJobInput, JobRecord };
}

export async function maybeGenerateOpenApi(): Promise<any | null> {
    if (readEnv('ENABLE_OPENAPI') !== 'true') return null;
    const schemas = buildSchemas();
    // Build minimal paths matching API
    const paths = {
        '/healthz': {
            get: {
                summary: 'Health check',
                responses: { 200: { description: 'OK' } },
            },
        },
        '/metrics': {
            get: {
                summary: 'Metrics snapshot',
                responses: { 200: { description: 'OK' } },
            },
        },
        '/api/jobs': {
            post: {
                summary: 'Create a clipping job',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                $ref: '#/components/schemas/CreateJobInput',
                            },
                        },
                    },
                },
                responses: {
                    200: {
                        description: 'Job created',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        correlationId: { type: 'string' },
                                        job: {
                                            $ref: '#/components/schemas/JobRecord',
                                        },
                                    },
                                    required: ['correlationId', 'job'],
                                },
                            },
                        },
                    },
                    400: { description: 'Validation error' },
                    429: { description: 'Rate limited' },
                },
            },
        },
        '/api/jobs/{id}': {
            get: {
                summary: 'Get job status',
                parameters: [
                    {
                        name: 'id',
                        in: 'path',
                        required: true,
                        schema: { type: 'string', format: 'uuid' },
                    },
                ],
                responses: {
                    200: {
                        description: 'Job status and events',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        correlationId: { type: 'string' },
                                        job: {
                                            $ref: '#/components/schemas/JobRecord',
                                        },
                                        events: {
                                            type: 'array',
                                            items: {
                                                type: 'object',
                                                properties: {
                                                    ts: {
                                                        type: 'string',
                                                        format: 'date-time',
                                                    },
                                                    type: { type: 'string' },
                                                    data: {
                                                        type: 'object',
                                                        additionalProperties:
                                                            true,
                                                    },
                                                },
                                                required: ['ts', 'type'],
                                            },
                                        },
                                    },
                                    required: ['correlationId', 'job'],
                                },
                            },
                        },
                    },
                    404: { description: 'Not found' },
                    410: { description: 'Gone (expired)' },
                },
            },
        },
        '/api/jobs/{id}/result': {
            get: {
                summary: 'Get result for a completed job',
                parameters: [
                    {
                        name: 'id',
                        in: 'path',
                        required: true,
                        schema: { type: 'string', format: 'uuid' },
                    },
                ],
                responses: {
                    200: { description: 'Signed URLs for assets' },
                    404: { description: 'Not ready or not found' },
                    410: { description: 'Gone (expired)' },
                },
            },
        },
    } as const;
    return {
        openapi: '3.0.0',
        info: { title: 'Clipper API', version: '1.0.0' },
        paths,
        components: {
            schemas: {
                CreateJobInput: schemas.CreateJobInput,
                JobRecord: schemas.JobRecord,
            },
        },
    };
}
