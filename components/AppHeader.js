"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import ProfileAvatar from "./ProfileAvatar.js";
import { useProfile } from "./ProfileProvider.js";
import { DEFAULT_PROFILE_AVATAR_ID } from "../lib/profiles/avatars.js";

const links = [
  { href: "/", label: "Home", id: "home" },
  { href: "/search", label: "Search", id: "search" },
  { href: "/discover", label: "Discover", id: "discover" },
  { href: "/history", label: "History", id: "history" },
  { href: "/debrid-library", label: "Debrid Library", id: "debrid-library" },
  { href: "/settings", label: "Settings", id: "settings" },
];

export default function AppHeader({ active = "" }) {
  const { activeProfile, profiles, select } = useProfile();
  const [navOpen, setNavOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const headerRef = useRef(null);
  const profileTriggerRef = useRef(null);
  const profileMenuRef = useRef(null);
  const otherProfiles = profiles.filter((profile) => profile.id !== activeProfile?.id);

  function focusProfileItem(position = 0) {
    requestAnimationFrame(() => {
      const items = profileMenuRef.current?.querySelectorAll('[role="menuitem"]') || [];
      items[position]?.focus();
    });
  }

  function handleProfileMenuKeyDown(event) {
    const items = [...(profileMenuRef.current?.querySelectorAll('[role="menuitem"]') || [])];
    const currentIndex = items.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = (currentIndex + direction + items.length) % items.length;
      items[nextIndex]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setProfileOpen(false);
      profileTriggerRef.current?.focus();
    }
  }

  useEffect(() => {
    if (!navOpen && !profileOpen) return undefined;
    function closeMenus(event) {
      if (event.key === "Escape") {
        setNavOpen(false);
        setProfileOpen(false);
        return;
      }
      if (event.type === "pointerdown" && !headerRef.current?.contains(event.target)) {
        setNavOpen(false);
        setProfileOpen(false);
      }
    }
    document.addEventListener("keydown", closeMenus);
    document.addEventListener("pointerdown", closeMenus);
    return () => {
      document.removeEventListener("keydown", closeMenus);
      document.removeEventListener("pointerdown", closeMenus);
    };
  }, [navOpen, profileOpen]);

  return (
    <header className="appHeader" ref={headerRef}>
      <Link className="brand" href="/" aria-label="TorPlay home">
        <span className="brandMark" aria-hidden="true">▶</span>
        <span>TorPlay</span>
      </Link>

      <nav className={navOpen ? "mainNav open" : "mainNav"} id="main-navigation" aria-label="Main navigation">
        {links.map((link) => (
          <Link
            className={active === link.id ? "active" : ""}
            href={link.href}
            aria-current={active === link.id ? "page" : undefined}
            key={link.id}
            onClick={() => setNavOpen(false)}
          >
            {link.label}
          </Link>
        ))}
      </nav>

      <button
        className="navToggle"
        type="button"
        aria-label={navOpen ? "Close navigation" : "Open navigation"}
        aria-expanded={navOpen}
        aria-controls="main-navigation"
        onClick={() => {
          setNavOpen((open) => !open);
          setProfileOpen(false);
        }}
      >
        <span />
        <span />
        <span />
      </button>

      <div className="profileControl">
        <button
          className={profileOpen ? "profileTrigger open" : "profileTrigger"}
          ref={profileTriggerRef}
          type="button"
          aria-label={`Profile menu${activeProfile ? ` for ${activeProfile.name}` : ""}`}
          aria-expanded={profileOpen}
          aria-controls="profile-menu"
          onClick={() => {
            setProfileOpen((open) => !open);
            setNavOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setProfileOpen(true);
              setNavOpen(false);
              focusProfileItem(0);
            }
          }}
        >
          <ProfileAvatar avatarId={activeProfile?.avatarId || DEFAULT_PROFILE_AVATAR_ID} size="small" />
          <span className="profileTriggerName">{activeProfile?.name || "Profiles"}</span>
          <span className="profileChevron" aria-hidden="true">⌄</span>
        </button>

        {profileOpen ? (
          <div
            className="profileMenu"
            id="profile-menu"
            role="menu"
            aria-label="Profiles"
            ref={profileMenuRef}
            onKeyDown={handleProfileMenuKeyDown}
          >
            {activeProfile ? (
              <div className="profileMenuCurrent" role="presentation">
                <ProfileAvatar avatarId={activeProfile.avatarId} size="small" />
                <span><strong>{activeProfile.name}</strong><small>Watching</small></span>
              </div>
            ) : null}
            {otherProfiles.length ? <span className="profileMenuLabel">Switch profile</span> : null}
            {otherProfiles.map((profile) => (
              <button
                className="profileMenuProfile"
                type="button"
                role="menuitem"
                key={profile.id}
                onClick={() => {
                  setProfileOpen(false);
                  select(profile.id);
                }}
              >
                <ProfileAvatar avatarId={profile.avatarId} size="small" />
                <span>{profile.name}</span>
              </button>
            ))}
            <div className="profileMenuActions">
              <Link href="/profiles" role="menuitem" onClick={() => setProfileOpen(false)}>Manage Profiles</Link>
              <Link href="/profiles?add=1" role="menuitem" onClick={() => setProfileOpen(false)}>Add Profile</Link>
            </div>
          </div>
        ) : null}
      </div>
    </header>
  );
}
