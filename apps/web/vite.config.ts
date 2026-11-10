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
      workbox: {
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        // Offline shows the last saved snapshot. Cleared on sign out and when the server says the session is gone.
        // /api/auth/session is deliberately not cached: a saved "signed in" answer would hide a revoked session.
        runtimeCaching: [
          {
            urlPattern: ({ url }: { url: URL }) => /^\/api\/(today|week|trends|races|sync\/status)$/.test(url.pathname),
            handler: "NetworkFirst",
            options: { cacheName: "pulse-api", networkTimeoutSeconds: 4, expiration: { maxEntries: 40, maxAgeSeconds: 7 * 24 * 3600 }, cacheableResponse: { statuses: [200] } },
          },
        ],
      },
    }),
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: 5173, proxy: { "/api": "http://localhost:8200" } },
  test: { include: ["src/**/*.test.{ts,tsx}"] },
});
