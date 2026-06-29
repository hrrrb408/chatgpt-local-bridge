#!/usr/bin/env node
import { loadConfig, type LoadedConfig } from "./config/loader.js";
import type { Config } from "./config/schema.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  let loaded: LoadedConfig;
  try {
    loaded = loadConfig();
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  const { config, created, path: cfgPath } = loaded;

  const { app, pathCtx, close } = await startServer(config);

  app.listen(config.server.port, config.server.host, () => {
    printBanner(config, cfgPath, created, pathCtx.allowedRoots);
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return; // SIGINT and SIGTERM can both fire — guard against double cleanup
    shuttingDown = true;
    try {
      await close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function printBanner(config: Config, cfgPath: string, created: boolean, allowedRoots: string[]): void {
  const localUrl = `http://${config.server.host}:${config.server.port}/mcp`;
  const line = "─".repeat(60);
  const out = [
    "",
    line,
    "  chatgpt-local-bridge — MCP server started",
    line,
    `  Local URL    : ${localUrl}   (for local self-test; ChatGPT cannot reach localhost)`,
    `  Config       : ${cfgPath}`,
    `  Permission   : Level ${config.permissions.level} (${["read-only", "edit", "full"][config.permissions.level]})`,
    `  Allowed dirs :${allowedRoots.length === 0 ? "  (none — all path tools will be denied!)" : ""}`,
    ...allowedRoots.map((r) => `                  • ${r}`),
    "",
    "  ▶ Step 1 — Expose a public HTTPS URL (ChatGPT requires a public endpoint):",
    "       ngrok http " + config.server.port,
    "       # or: cloudflared tunnel --url http://localhost:" + config.server.port,
    "     Append /mcp to the resulting https URL.",
    "",
    "  ▶ Step 2 — Connect in ChatGPT:",
    "       Settings → Connectors (Apps) → Advanced → enable Developer Mode",
    "       → Create connector → paste the https://.../mcp URL",
    "       → Auth: \"No authentication\" → Connect.",
    "",
    "  (Claude Desktop / Cursor support direct localhost — no tunnel needed.)",
    line,
    "",
  ];
  if (created) {
    out.push(`  ℹ  First run: generated default config at ${cfgPath}. Edit allowed_paths and restart.\n`);
  }
  process.stdout.write(out.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
