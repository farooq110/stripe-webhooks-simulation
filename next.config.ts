import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Allow the dev server's HMR websocket on 127.0.0.1 (QA finding BUG-7:
  // Playwright and some proxies hit the app on this origin, and without this
  // the page never hydrates in dev).
  allowedDevOrigins: ["127.0.0.1"],
  reactStrictMode: false,
};

export default nextConfig;
