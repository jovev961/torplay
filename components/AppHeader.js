"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import ProfileAvatar from "./ProfileAvatar.js";
import { useProfile } from "./ProfileProvider.js";
import { DEFAULT_PROFILE_AVATAR_ID } from "../lib/profiles/avatars.js";
import { useI18n } from "./I18nProvider.js";
import LanguageSwitcher from "./LanguageSwitcher.js";

const primaryLink = { href: "/", label: "Home", id: "home", icon: "home" };
const navCategories = [
  {
    id: "explore",
    label: "Explore",
    icon: "compass",
    links: [
      { href: "/search", label: "Search", id: "search", icon: "search" },
      { href: "/discover", label: "Discover", id: "discover", icon: "discover" },
      { href: "/recommendations", label: "Recommendations", id: "recommendations", icon: "sparkles" },
    ],
  },
  {
    id: "library",
    label: "Library",
    icon: "library",
    links: [
      { href: "/history", label: "History", id: "history", icon: "history" },
      { href: "/debrid-library", label: "Debrid Library", id: "debrid-library", icon: "cloud" },
    ],
  },
];
const settingsLink = { href: "/settings", label: "Settings", id: "settings", icon: "settings" };

function NavIcon({ name }) {
  const paths = {
    home: <><path d="m3 11 9-8 9 8" /><path d="M5 10v10h14V10" /><path d="M9 20v-6h6v6" /></>,
    compass: <><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2.2 4.8-4.8 2.2 2.2-4.8 4.8-2.2Z" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></>,
    discover: <><path d="M4 7h16M4 12h10M4 17h7" /><path d="m17 14 1.2 2.4L21 17l-2 1.9.5 2.8-2.5-1.3-2.5 1.3.5-2.8-2-1.9 2.8-.6L17 14Z" /></>,
    sparkles: <><path d="m12 2 1.4 4.1L17.5 7l-4.1 1.4L12 12.5l-1.4-4.1L6.5 7l4.1-.9L12 2Z" /><path d="m18.5 13 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2ZM5 13l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2Z" /></>,
    library: <><path d="M4 5h5v14H4zM10 5h5v14h-5z" /><path d="m16.5 5 3.5-1 3 13.5-3.5.8L16.5 5Z" /></>,
    history: <><path d="M4 5v5h5" /><path d="M5.4 9.5A8 8 0 1 1 5 15" /><path d="M12 8v5l3 2" /></>,
    cloud: <><path d="M7 18h11a4 4 0 0 0 .5-8A6.5 6.5 0 0 0 6 8.5 4.8 4.8 0 0 0 7 18Z" /><path d="m9 14 3-3 3 3M12 11v6" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>,
  };
  return <svg className="navIcon" aria-hidden="true" viewBox="0 0 24 24" focusable="false">{paths[name]}</svg>;
}

export default function AppHeader({ active = "" }) {
  const { t } = useI18n();
  const { activeProfile, profiles, select } = useProfile();
  const [navOpen, setNavOpen] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(null);
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
    if (!navOpen && !profileOpen && !categoryOpen) return undefined;
    function closeMenus(event) {
      if (event.key === "Escape") {
        setNavOpen(false);
        setCategoryOpen(null);
        setProfileOpen(false);
        return;
      }
      if (event.type === "pointerdown" && !headerRef.current?.contains(event.target)) {
        setNavOpen(false);
        setCategoryOpen(null);
        setProfileOpen(false);
      }
    }
    document.addEventListener("keydown", closeMenus);
    document.addEventListener("pointerdown", closeMenus);
    return () => {
      document.removeEventListener("keydown", closeMenus);
      document.removeEventListener("pointerdown", closeMenus);
    };
  }, [navOpen, profileOpen, categoryOpen]);

  function closeNavigation() {
    setNavOpen(false);
    setCategoryOpen(null);
  }

  function focusCategoryItem(categoryId, position = 0) {
    requestAnimationFrame(() => {
      const items = headerRef.current?.querySelectorAll(`[data-nav-category="${categoryId}"] a`) || [];
      items[position]?.focus();
    });
  }

  function handleCategoryKeyDown(event, category) {
    const items = [...(event.currentTarget.querySelectorAll("a"))];
    const currentIndex = items.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      items[(currentIndex + direction + items.length) % items.length]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setCategoryOpen(null);
      headerRef.current?.querySelector(`[data-nav-trigger="${category.id}"]`)?.focus();
    }
  }

  function navLink(link, nested = false) {
    return (
      <Link
        className={`${active === link.id ? "active" : ""}${nested ? " nested" : ""}`}
        href={link.href}
        aria-current={active === link.id ? "page" : undefined}
        key={link.id}
        onClick={closeNavigation}
      >
        <NavIcon name={link.icon} />
        <span>{t(link.label)}</span>
      </Link>
    );
  }

  return (
    <header className="appHeader" ref={headerRef}>
      <Link className="brand" href="/" aria-label={t("TorPlay home")}>
        <Image className="brandMark" src="/torplay-logo.png" alt="" width={34} height={34} />
        <span>TorPlay</span>
      </Link>

      <nav className={navOpen ? "mainNav open" : "mainNav"} id="main-navigation" aria-label={t("Main navigation")}>
        {navLink(primaryLink)}
        {navCategories.map((category) => {
          const categoryActive = category.links.some((link) => link.id === active);
          const expanded = navOpen || categoryOpen === category.id;
          return (
            <div
              className={`navCategory${categoryOpen === category.id ? " open" : ""}${categoryActive ? " active" : ""}`}
              data-nav-category={category.id}
              key={category.id}
              onKeyDown={(event) => handleCategoryKeyDown(event, category)}
            >
              <button
                className="navCategoryTrigger"
                type="button"
                data-nav-trigger={category.id}
                aria-expanded={expanded}
                onClick={() => {
                  setCategoryOpen((current) => current === category.id ? null : category.id);
                  setProfileOpen(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setCategoryOpen(category.id);
                    focusCategoryItem(category.id);
                  }
                }}
              >
                <NavIcon name={category.icon} />
                <span>{t(category.label)}</span>
                <span className="navCategoryChevron" aria-hidden="true">⌄</span>
              </button>
              <div className="navCategoryMenu">
                <span className="navCategoryHeading">{t(category.label)}</span>
                {category.links.map((link) => navLink(link, true))}
              </div>
            </div>
          );
        })}
        {navLink(settingsLink)}
      </nav>

      <button
        className="navToggle"
        type="button"
        aria-label={t(navOpen ? "Close navigation" : "Open navigation")}
        aria-expanded={navOpen}
        aria-controls="main-navigation"
        onClick={() => {
          setNavOpen((open) => !open);
          setCategoryOpen(null);
          setProfileOpen(false);
        }}
      >
        <span />
        <span />
        <span />
      </button>

      <LanguageSwitcher className="headerLanguageSwitcher" />

      <div className="profileControl">
        <button
          className={profileOpen ? "profileTrigger open" : "profileTrigger"}
          ref={profileTriggerRef}
          type="button"
          aria-label={activeProfile ? t(`Profile menu for ${activeProfile.name}`) : t("Profile menu")}
          aria-expanded={profileOpen}
          aria-controls="profile-menu"
          onClick={() => {
            setProfileOpen((open) => !open);
            setNavOpen(false);
            setCategoryOpen(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setProfileOpen(true);
              setNavOpen(false);
              setCategoryOpen(null);
              focusProfileItem(0);
            }
          }}
        >
          <ProfileAvatar avatarId={activeProfile?.avatarId || DEFAULT_PROFILE_AVATAR_ID} size="small" />
          <span className="profileTriggerName">{activeProfile?.name || t("Profiles")}</span>
          <span className="profileChevron" aria-hidden="true">⌄</span>
        </button>

        {profileOpen ? (
          <div
            className="profileMenu"
            id="profile-menu"
            role="menu"
            aria-label={t("Profiles")}
            ref={profileMenuRef}
            onKeyDown={handleProfileMenuKeyDown}
          >
            {activeProfile ? (
              <div className="profileMenuCurrent" role="presentation">
                <ProfileAvatar avatarId={activeProfile.avatarId} size="small" />
                <span><strong>{activeProfile.name}</strong><small>{t("Watching")}</small></span>
              </div>
            ) : null}
            {otherProfiles.length ? <span className="profileMenuLabel">{t("Switch profile")}</span> : null}
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
              <Link href="/profiles" role="menuitem" onClick={() => setProfileOpen(false)}>{t("Manage Profiles")}</Link>
              <Link href="/profiles?add=1" role="menuitem" onClick={() => setProfileOpen(false)}>{t("Add Profile")}</Link>
            </div>
          </div>
        ) : null}
      </div>
    </header>
  );
}
