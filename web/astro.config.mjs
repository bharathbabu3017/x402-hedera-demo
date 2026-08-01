import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import icon from "astro-icon";

export default defineConfig({
  site: "https://x402-agent-marketplace.example",
  vite: { plugins: [tailwindcss()] },
  integrations: [icon()],
});
