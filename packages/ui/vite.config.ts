import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = fileURLToPath(new URL(".", import.meta.url));

// MCP 모드의 상태 화면(status.html). MCP 서버가 Vite 미들웨어로 띄운다 (packages/mcp/src/statusServer.ts)
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: { input: { status: resolve(root, "status.html") } },
  },
});
