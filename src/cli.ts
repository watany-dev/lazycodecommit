#!/usr/bin/env node
import { processIo } from "./cli/io.js";
import { run } from "./cli/main.js";
import { createGit } from "./git/git.js";
import { loadConfig } from "./state/config.js";

process.exitCode = await run(process.argv.slice(2), {
  io: processIo(),
  createGit,
  // The SDK is the heavy part of the bundle; load it only for commands that call AWS.
  createApi: async (options) => (await import("./aws/codecommit.js")).createCodeCommitApi(options),
  loadConfig,
  openReview: async (request) => (await import("./tui/index.js")).openReview(request),
});
