import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets devices on the same LAN (e.g. a phone at this IP) load dev-mode JS
  // assets from this machine's dev server for local testing.
  allowedDevOrigins: ["192.168.10.115"],
};

export default nextConfig;
