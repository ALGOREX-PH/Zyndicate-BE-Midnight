import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Each test file builds its own app with an isolated in-memory database.
    fileParallelism: true,
    testTimeout: 15000,
    hookTimeout: 15000
  }
});
