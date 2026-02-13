#!/usr/bin/env node
// Compatibility shim so "node start" works (some Render setups use that).
// Delegates to the real server entrypoint.
require('./Hjksurvivor/server.js');
