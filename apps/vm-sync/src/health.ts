import { createServer, type Server } from "node:http";
import type { VmConfig } from "./config.js";
import type { RuntimeStats } from "./types.js";

export function startHealthServer(
  config: VmConfig,
  stats: RuntimeStats,
): Server {
  const server = createServer((req, res) => {
    if (req.url === "/health" || req.url === "/ready") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          ok: true,
          service: "market-hub-vm-sync",
          mode: config.mode,
          marketplaceWritesUnlocked: config.marketplaceWritesUnlocked,
          stats,
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "not_found" }));
  });

  server.listen(config.healthPort, "0.0.0.0");
  return server;
}
