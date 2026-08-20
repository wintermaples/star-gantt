import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const dist = fileURLToPath(new URL("../packages/stargantt/dist/stargantt.js", import.meta.url));

export default defineConfig({
  // The docs site consumes the *shipped bundle*, exactly as a reader's own project would.
  // Types come from the packages' sources via tsconfig `paths` — see tsconfig.json.
  // Consequence: run `pnpm run build` in the repository root before `pnpm run dev` here,
  // or the site documents a stale artifact.
  resolve: { alias: { stargantt: dist } },
  plugins: [react()],
  server: { port: 4175, host: true, fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] } },
});
