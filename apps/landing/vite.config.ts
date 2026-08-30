import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  publicDir: resolve(import.meta.dirname, "../../docs/assets"),
  build: {
    assetsInlineLimit: 0,
    sourcemap: true,
  },
});
