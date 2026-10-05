import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  base: "/designer/",
  plugins: [react()],
  build: {
    outDir: "dist-designer",
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL("./designer.html", import.meta.url)),
    },
  },
});
