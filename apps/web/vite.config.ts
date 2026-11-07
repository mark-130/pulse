import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { APP_NAME, APP_SHORT_NAME, THEME_COLOR_DARK, THEME_COLOR_LIGHT } from "@pulse/shared/brand";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { VitePWA } from "vite-plugin-pwa";

const brandHtml: Plugin = {
  name: "brand-html",
  transformIndexHtml: (html) => html
      .replaceAll("%APP_NAME%", APP_NAME)
      .replaceAll("%APP_SHORT_NAME%", APP_SHORT_NAME)
      .replaceAll("%THEME_COLOR_DARK%", THEME_COLOR_DARK)
      .replaceAll("%THEME_COLOR_LIGHT%", THEME_COLOR_LIGHT),
};

export default defineConfig({
  plugins: [
    brandHtml,
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: APP_NAME,
        short_name: APP_SHORT_NAME,
        description: "Training and home dashboard",
        lang: "en-GB",
        start_url: "/",
        display: "standalone",
        background_color: THEME_COLOR_DARK,
        theme_color: THEME_COLOR_DARK,
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: { navigateFallbackDenylist: [/^\/api\//], globPatterns: ["**/*.{js,css,html,svg,png,woff2}"] },
    }),
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: 5173, proxy: { "/api": "http://localhost:8200" } },
  test: { include: ["src/**/*.test.ts"] },
});
