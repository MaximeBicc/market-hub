import { loadConfig } from "./config.js";
import { HttpControlPlane } from "./control-plane.js";
import { startHealthServer } from "./health.js";
import { Logger } from "./log.js";
import { VmRuntime } from "./runtime.js";

const config = loadConfig();
const log = new Logger(config.logLevel);
const controlPlane = new HttpControlPlane(
  config.controlPlaneUrl,
  config.controlPlaneToken,
);
const runtime = new VmRuntime(config, controlPlane, log);
const health = startHealthServer(config, runtime.stats);

let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info("vm.shutdown", { signal });
  runtime.stop();
  health.close();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await runtime.start();
