import "./globals.css";
import { ProfileProvider } from "../components/ProfileProvider.js";
import { I18nProvider } from "../components/I18nProvider.js";
import { getServerI18n } from "./_lib/i18n.js";
import { WatchTogetherProvider } from "../components/WatchTogetherProvider.js";
import WatchTogetherDock from "../components/WatchTogetherDock.js";

export async function generateMetadata() {
  const { t } = await getServerI18n();
  return {
    title: t("TorPlay · Movies and Shows"),
    description: t("Browse movie and show metadata and stream authorized video sources."),
    manifest: "/manifest.webmanifest",
    appleWebApp: { capable: true, title: "TorPlay", statusBarStyle: "black-translucent" },
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
}

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }) {
  const { locale } = await getServerI18n();
  return (
    <html lang={locale}>
      <body><I18nProvider initialLocale={locale}><ProfileProvider><WatchTogetherProvider>
        {children}<WatchTogetherDock />
      </WatchTogetherProvider></ProfileProvider></I18nProvider></body>
    </html>
  );
}
