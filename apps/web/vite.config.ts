import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Self-signed HTTPS: Web Crypto (device identities, envelope encryption)
    // requires a secure context, and localhost doesn't count on OTHER
    // devices. Phones hitting the LAN URL get a cert warning once — proceed.
    basicSsl(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "ScreenMesh",
        short_name: "ScreenMesh",
        description:
          "Encrypted device-to-device relay. Move notes, links, files, and clipboard items across your machines — no accounts, no cloud, no trace left behind.",
        theme_color: "#fafafa",
        background_color: "#fafafa",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" }
        ]
      }
    })
  ],
  server: {
    port: 5173,
    // Listen on all interfaces so phones on the same Wi-Fi can connect.
    host: true,
    // Same-origin proxy to the relay server: the page, the pairing API, and
    // the WebSocket all share one origin/cert — no CORS, no mixed content.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        ws: true
      }
    }
  }
});
