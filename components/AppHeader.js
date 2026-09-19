"use client";

import Link from "next/link";
import { useProfile } from "./ProfileProvider.js";

const links = [
  { href: "/", label: "Home", id: "home" },
  { href: "/search", label: "Search", id: "search" },
  { href: "/discover", label: "Discover", id: "discover" },
  { href: "/history", label: "History", id: "history" },
  { href: "/settings", label: "Settings", id: "settings" },
];

export default function AppHeader({ active = "" }) {
  const { activeProfile } = useProfile();
  return (
    <header className="appHeader">
      <Link className="brand" href="/">TorPlay</Link>
      <nav aria-label="Main navigation">
        {links.map((link) => (
          <Link
            className={active === link.id ? "active" : ""}
            href={link.href}
            aria-current={active === link.id ? "page" : undefined}
            key={link.id}
          >
            {link.label}
          </Link>
        ))}
        <Link className={active === "profiles" ? "active profileLink" : "profileLink"} href="/profiles">
          {activeProfile?.name || "Profiles"}
        </Link>
      </nav>
    </header>
  );
}
