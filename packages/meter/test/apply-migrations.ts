import { applyD1Migrations, env } from "cloudflare:test";

// Every test file starts from the real schema, applied by the real migration runner.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
