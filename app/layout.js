import "./globals.css";
import { ProfileProvider } from "../components/ProfileProvider.js";

export const metadata = {
  title: "TorPlay · Movies and Shows",
  description: "Browse movie and show metadata and stream authorized video sources.",
  icons: {
    icon: [{
      url: "/torplay-favicon-v2.ico",
      type: "image/x-icon",
      sizes: "16x16 24x24 32x32 48x48 64x64 128x128 256x256",
    }],
    shortcut: ["/torplay-favicon-v2.ico"],
    apple: [{ url: "/torplay-apple-icon-v2.png", type: "image/png", sizes: "180x180" }],
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body><ProfileProvider>{children}</ProfileProvider></body>
    </html>
  );
}
