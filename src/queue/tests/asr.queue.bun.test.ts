import { describe, test, expect } from 'bun:test';
import { AsrQueuePayloadSchema } from '@clipper/queue/asr';
import { PgBossQueueAdapter } from '@clipper/queue';
import { QUEUE_TOPIC_ASR } from '@clipper/queue';

// Schema validation tests

describe('ASR Queue Schema', () => {
    test('accepts valid payload', () => {
        const ok = AsrQueuePayloadSchema.parse({
            asrJobId: crypto.randomUUID(),
            clipJobId: crypto.randomUUID(),
            languageHint: 'auto',
        });
        expect(ok.asrJobId).toBeTruthy();
    });

    test('rejects invalid uuid', () => {
        expect(() =>
            AsrQueuePayloadSchema.parse({ asrJobId: 'not-a-uuid' })
        ).toThrow();
    });
});

// Adapter routing (publishTo API) - smoke test (no actual DB required)
describe('PgBoss publishTo API (smoke)', () => {
    test('has publishTo method', () => {
        const q = new PgBossQueueAdapter({
            connectionString: 'postgres://ignored',
        });
        expect(typeof (q as any).publishTo).toBe('function');
        // Do not call publishTo here since it would require a real DB connection
        // This is a compile-time/interface presence assertion.
        void QUEUE_TOPIC_ASR;
    });
});
