import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Os arquivos dividem o mesmo banco, e o teste de histórico reaplica uma
    // migration (DDL em `cards`): em paralelo, isso gera deadlock no Postgres.
    fileParallelism: false,
    coverage: {
      include: ["src/**"],
      exclude: ["src/server.ts"],
      reporter: ["text", "html"],
    },
  },
});
