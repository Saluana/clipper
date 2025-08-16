#!/usr/bin/env bun
import { maybeGenerateOpenApi } from '@clipper/contracts';
import { readEnv } from '@clipper/common';

const main = async () => {
    const enable =
        (readEnv('ENABLE_OPENAPI') || 'true').toLowerCase() === 'true';
    if (!enable) {
        console.error('OpenAPI generation disabled. Set ENABLE_OPENAPI=true');
        process.exit(1);
    }
    const doc = await maybeGenerateOpenApi();
    if (!doc) {
        console.error('No document generated.');
        process.exit(1);
    }
    console.log(JSON.stringify(doc, null, 2));
};

main();
