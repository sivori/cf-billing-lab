import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// Tests run inside workerd against real D1, R2 and KV in Miniflare — not mocks.
// Idempotency and reconciliation claims are only worth making against the real storage engines.
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
  },
});
