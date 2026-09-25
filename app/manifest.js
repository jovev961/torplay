export default function manifest() {
  return {
    name: "TorPlay",
    short_name: "TorPlay",
    description: "Discover and watch authorized video sources.",
    start_url: "/",
    scope: "/",
    display: "fullscreen",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [{ src: "/torplay-apple-icon-v2.png", sizes: "180x180", type: "image/png" }],
  };
}
