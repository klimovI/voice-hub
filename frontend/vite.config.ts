// Voice Hub — Vite multi-page config
//
// Build output: ../web (repo root web/ served by Go + referenced by Tauri)
//
// Auth whitelist approach:
//   Vite emits hashed assets under /assets/*.js|css.
//   We extend Go's requireAuthHTML to pass through any request whose path
//   starts with "/assets/" or "/vendor/" — both are pure static files with
//   no sensitive content. That single Go change covers all Vite-generated
//   bundles including the login page's JS chunk without us needing stable
//   filenames.
//
//   login.html itself is whitelisted by path. Its hashed JS bundle lands
//   in /assets/ which is now also whitelisted. Result: /login.html +
//   /assets/login-*.js all reach the browser unauthenticated.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],

  base: "/",

  build: {
    outDir: "../web",
    emptyOutDir: true,
    sourcemap: false,

    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        login: resolve(__dirname, "login.html"),
      },
      // Vendor modules are served as static assets at runtime — not bundled.
      // TypeScript paths map these to .d.ts stubs for type-checking only.
      external: ["/vendor/rnnoise/rnnoise.js", "/vendor/dtln/dtln.mjs"],
    },
  },
});
