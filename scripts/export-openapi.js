'use strict';

const { buildOpenApi } = require('../src/openapi');

process.stdout.write(JSON.stringify(buildOpenApi(), null, 2) + '\n');
