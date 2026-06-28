/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Each running instance needs its OWN build dir. The investor demo (:3000)
  // and the live-demo instance (:5678) run from this same project dir, and two
  // Next servers sharing one `.next` corrupt each other (random 404s). The
  // dev:live / start:live scripts set NEXT_DIST_DIR=.next-live to isolate.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

module.exports = nextConfig;
