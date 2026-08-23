import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
    rollupOptions: {
      // 设置面板和测试面板都是独立窗口（见 README），所以各是一个入口。
      input: {
        main: resolve(__dirname, "index.html"),
        settings: resolve(__dirname, "settings.html"),
        test: resolve(__dirname, "test.html"),
      },
    },
  },
});
