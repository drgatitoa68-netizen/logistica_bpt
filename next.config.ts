import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["*.app.github.dev", "*.csb.app", "*.githubpreview.dev", "*.preview.app.github.dev"],
  experimental: {
    serverActions: {
      allowedOrigins: ["*.app.github.dev", "*.csb.app", "*.githubpreview.dev", "localhost:3000"],
    },
  },
};

export default nextConfig;
