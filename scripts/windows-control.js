import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./windows-control-runtime.js";

export * from "./windows-control-runtime.js";

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then(() => {
    process.exit(0);
  }, (error) => {
    console.error(`[TorPlay] ${error.message}`);
    process.exit(1);
  });
}
