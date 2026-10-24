import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "./shared"),
      "react-native": "react-native-web",
    },
  },
  optimizeDeps: {
    // maplibre-gl v6 ships its tile worker as a separate .mjs file that Vite's pre-bundler drops
    exclude: ["maplibre-gl"],
  },
  server: {
    port: 5173,
    host: true,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
