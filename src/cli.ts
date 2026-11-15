#!/usr/bin/env node
// Placeholder entry point so build, packaging and startup checks have
// something to run. Commands arrive with Phase 1 of docs/dev/spec.ja.md.
import { run } from "./run.js";

process.exitCode = run(process.argv.slice(2), (line) => console.log(line));
