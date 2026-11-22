// Static build for GitHub Pages: `bun run build:pages` -> dist-pages/. Not used by the Lovable preview.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: "pages",
  base: process.env["PAGES_BASE"] ?? "./",
  publicDir: fileURLToPath(new URL("./public", import.meta.url)),
  envDir: fileURLToPath(new URL(".", import.meta.url)),
  define: { "import.meta.env.VITE_STATIC": JSON.stringify("1") },
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: fileURLToPath(new URL("./dist-pages", import.meta.url)), emptyOutDir: true },
});
