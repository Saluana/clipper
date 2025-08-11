import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
    resolve: {
        alias: {
            '@clipper/common': path.resolve(__dirname, 'src/common'),
            '@clipper/ffmpeg': path.resolve(__dirname, 'src/ffmpeg'),
            '@clipper/data': path.resolve(__dirname, 'src/data'),
            '@clipper/queue': path.resolve(__dirname, 'src/queue'),
            '@clipper/contracts': path.resolve(__dirname, 'src/contracts'),
        },
    },
    test: {
        include: ['src/**/*.test.ts', 'src/**/*.integration.test.ts'],
        testTimeout: 60000,
    },
});
