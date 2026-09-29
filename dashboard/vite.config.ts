import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
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
        manualChunks: {
          canvas: ["@xyflow/react"],
          formats: ["yaml", "smol-toml"],
          validation: ["zod"],
          "vector-schema": ["./src/generated/vector-schema.json"],
        },
      },
    },
  },
});
