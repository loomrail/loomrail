import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react-vendor",
              priority: 50,
              test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
            },
            {
              name: "radix-vendor",
              priority: 40,
              test: /node_modules[\\/]@radix-ui[\\/]/,
            },
            {
              name: "tanstack-vendor",
              priority: 30,
              test: /node_modules[\\/]@tanstack[\\/]/,
            },
            {
              name: "validation-vendor",
              priority: 20,
              test: /node_modules[\\/]zod[\\/]/,
            },
            {
              name: "vendor",
              priority: 10,
              test: /node_modules[\\/]/,
            },
          ],
        },
      },
    },
    sourcemap: true,
  },
});
