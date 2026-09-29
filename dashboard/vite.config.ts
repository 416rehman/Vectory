import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Split vendor code by who needs it. React stays in a shared vendor chunk so the
// pipeline canvas (React Flow) loads only with the editor, never on sign-in.
function chunkFor(id: string) {
  const path = id.replaceAll("\\", "/");
  if (path.includes("/node_modules/@xyflow/")) return "canvas";
  if (/\/node_modules\/(react|react-dom|scheduler)\//.test(path))
    return "vendor";
  if (/\/node_modules\/(yaml|smol-toml)\//.test(path)) return "formats";
  if (path.includes("/node_modules/zod/")) return "validation";
  if (path.endsWith("/src/generated/vector-schema.json"))
    return "vector-schema";
  return undefined;
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:8080", changeOrigin: false } },
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        "api-reference": fileURLToPath(
          new URL("./api-reference.html", import.meta.url),
        ),
      },
      output: {
        manualChunks: chunkFor,
      },
    },
  },
});
