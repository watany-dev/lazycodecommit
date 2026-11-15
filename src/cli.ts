#!/usr/bin/env node
import { exitOnClosedPipe, processIo } from "./cli/io.js";
import { run } from "./cli/main.js";
import { createGit } from "./git/git.js";
import { loadConfig } from "./state/config.js";
import { createLocalState } from "./state/local.js";

exitOnClosedPipe(process.stdout, process.exit);
exitOnClosedPipe(process.stderr, process.exit);

let quit = false;
process.exitCode = await run(process.argv.slice(2), {
  io: processIo(),
  createGit,
  // The SDK is the heavy part of the bundle; load it only for commands that call AWS.
  createApi: async (options) => (await import("./aws/codecommit.js")).createCodeCommitApi(options),
  createCiApi: async (options) => (await import("./aws/ci.js")).createCiApi(options),
  loadConfig,
  createState: createLocalState,
  openReview: async (request) => (await import("./tui/index.js")).openReview(request),
  openTop: async (request) => {
    await (await import("./tui/index.js")).openTop(request);
    // Detail calls still in flight after q would keep the process (and the
    // terminal) for seconds; nothing is waiting for them.
    quit = true;
  },
});
if (quit) process.exit();
