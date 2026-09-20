import "./globals.css";
import { ProfileProvider } from "../components/ProfileProvider.js";

export const metadata = {
  title: "TorPlay · Movies and Shows",
  description: "Browse movie and show metadata and stream authorized video sources.",
  icons: {
    icon: [{ url: "/torplay-browser-icon-v1.png", type: "image/png", sizes: "256x256" }],
    shortcut: ["/torplay-browser-icon-v1.png"],
    apple: [{ url: "/torplay-apple-icon-v1.png", type: "image/png", sizes: "180x180" }],
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body><ProfileProvider>{children}</ProfileProvider></body>
    </html>
  );
}
