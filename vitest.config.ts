import { defineConfig } from "vitest/config"

/**
 * Run this suite with `bun run test`, which is `bun run --bun vitest run`.
 *
 * The `--bun` matters: Vitest's bin shebang is `#!/usr/bin/env node`, and a Node
 * worker has no `Bun` global, so `Bun.serve` inside the mock application throws
 * `Bun is not defined`. Forcing the Bun runtime is the whole fix.
 *
 * `@cua/*` needs no alias here; it resolves through the workspace symlinks in
 * `node_modules`, the same way it does under `bun run` and `tsc`.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // These drive a real browser against the real mock application from ticket 02
    // onwards. They are not unit tests and should not be timed like them.
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
