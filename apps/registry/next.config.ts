import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    typedRoutes: false,
  },
  transpilePackages: ["@agentpack/core"],
};

export default nextConfig;
