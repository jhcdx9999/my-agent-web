import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": process.env.VITE_API_TARGET ?? "http://127.0.0.1:8787",
      "/downloads": process.env.VITE_API_TARGET ?? "http://127.0.0.1:8787"
    }
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true
  }
});
