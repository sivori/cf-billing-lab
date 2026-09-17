import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Tests run inside workerd against real D1, R2 and KV in Miniflare — not mocks.
 *
 * Claims about idempotent replay and about reconciliation are claims about what SQLite and R2 do
 * under concurrent, repeated writes. A mock would only prove that the test author and the
 * implementation author had the same misunderstanding.
 */
export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(here, "migrations"));
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
        },
      },
    },
  };
});
