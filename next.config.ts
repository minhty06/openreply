import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  // The app is built off-box (in CI) and shipped as a prebuilt artifact, because
  // the 1 GB worker host cannot run `next build`. Standalone output traces just
  // the modules the server needs, so the box runs it without `npm ci`.
  // `public` and `.next/static` are NOT included automatically — the release
  // workflow copies them in.
  output: "standalone",
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
