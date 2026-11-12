import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const serverPort = process.env.SERVER_PORT ?? "8787";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  // 페이지 둘: 웹 앱(index.html), MCP 모드 상태 화면(status.html, MCP 서버가 띄운다)
  build: {
    rollupOptions: { input: { main: resolve(root, "index.html"), status: resolve(root, "status.html") } },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": `http://127.0.0.1:${serverPort}`,
    },
  },
});
