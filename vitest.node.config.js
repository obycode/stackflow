/// <reference types="vitest" />

import { defineConfig } from "vite";

export default defineConfig({
  test: {
    environment: "node",
    pool: "forks",
    poolOptions: {
      threads: { singleThread: true },
      forks: { singleFork: true },
    },
    setupFiles: [],
  },
});
