import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      "/api": {
        // 127.0.0.1, не localhost: сервер слушает IPv4, а localhost на Windows
        // часто резолвится в IPv6 (::1) -> прокси к API не достучится.
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
      },
    },
  },
});
