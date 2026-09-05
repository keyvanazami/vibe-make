/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emits .next/standalone: a minimal server bundled with only the files the
  // app actually traces to. Keeps the container image small.
  output: "standalone",
  experimental: {
    serverComponentsExternalPackages: [],
  },
};

export default nextConfig;
