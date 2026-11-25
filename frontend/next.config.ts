import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep Turbopack scoped to this app when the repository also has a root lockfile.
  turbopack: { root: __dirname },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${process.env.API_BACKEND_URL ?? "http://localhost:3000"}/api/:path*` }];
  },
};

export default nextConfig;
