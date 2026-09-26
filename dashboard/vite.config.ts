import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:8080", changeOrigin: false } },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          canvas: ["@xyflow/react"],
          formats: ["yaml", "smol-toml"],
          validation: ["zod"],
        },
      },
    },
  },
});
