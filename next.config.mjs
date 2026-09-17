/** @type {import('next').NextConfig} */
const nextConfig = {
  agentRules: false,
  ...(process.env.TORPLAY_STANDALONE_BUILD === "1" ? { output: "standalone" } : {}),
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "image.tmdb.org",
        pathname: "/t/p/**",
      },
    ],
  },
  serverExternalPackages: [
    "webtorrent",
    "parse-torrent",
    "ffmpeg-static",
    "ffprobe-static",
    "better-sqlite3",
  ],
};

export default nextConfig;
