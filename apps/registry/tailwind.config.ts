import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: {
          50: "#f5f6f8",
          100: "#e9ebf0",
          200: "#cdd2dc",
          400: "#8a92a3",
          600: "#475066",
          800: "#1c2233",
          900: "#0d1120",
          950: "#070914",
        },
        accent: {
          50: "#eef4ff",
          100: "#dbe5ff",
          400: "#7ea1ff",
          500: "#5079ff",
          600: "#3257ee",
          700: "#2440c8",
        },
        risk: {
          low: "#15803d",
          medium: "#b45309",
          high: "#b91c1c",
          critical: "#7f1d1d",
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'Menlo', 'monospace'],
      },
      boxShadow: {
        soft: "0 1px 2px rgba(13,17,32,0.06), 0 4px 12px rgba(13,17,32,0.04)",
      },
    },
  },
  plugins: [],
};

export default config;
