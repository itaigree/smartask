/**
 * Static export for GitHub Pages: `next build` emits a plain `out/` folder with
 * no server (PLAN.md decision 6b).
 *
 * A project site is served from a subfolder, e.g. /smartask, so every asset URL
 * needs that prefix. It comes from the environment rather than being hardcoded,
 * so moving to a custom domain later means changing one workflow line, not code.
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'export',
  basePath,
  // GitHub Pages serves /foo/ rather than /foo, so emit directories with index.html.
  trailingSlash: true,
  // There is no server to optimise images on demand.
  images: { unoptimized: true },
};

export default nextConfig;
