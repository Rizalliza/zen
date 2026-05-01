#!/usr/bin/env node
'use strict';

const { main } = require('./utilities/poolFetchCustom_raw');

if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = require('./utilities/poolFetchCustom_raw');
