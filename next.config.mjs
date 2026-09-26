/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ['192.168.1.104', `192.168.1.109`, '172.20.10.2', '192.168.100.216', '192.168.1.234'],
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
