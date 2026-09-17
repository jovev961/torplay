import "./globals.css";
import { ProfileProvider } from "../components/ProfileProvider.js";

export const metadata = {
  title: "TorPlay · Movies and Shows",
  description: "Browse movie and show metadata and stream authorized video sources.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body><ProfileProvider>{children}</ProfileProvider></body>
    </html>
  );
}
