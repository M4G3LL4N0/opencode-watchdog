#!/usr/bin/env node
import { main } from "../dist/src/cli/index.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code ?? 0;
  },
  (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ocw: ${msg}\n`);
    process.exitCode = 1;
  },
);