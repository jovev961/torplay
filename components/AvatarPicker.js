"use client";

import { useEffect, useState } from "react";
import ProfileAvatar from "./ProfileAvatar.js";
import { useI18n } from "./I18nProvider.js";

export default function AvatarPicker({ value, onChange, legend = "Choose an avatar" }) {
  const { t } = useI18n();
  const [avatars, setAvatars] = useState([]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/profile-avatars", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("Avatar request failed.")))
      .then((data) => { if (!cancelled) setAvatars(data.avatars || []); })
      .catch(() => { if (!cancelled) setAvatars([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (avatars.length && !avatars.some((avatar) => avatar.id === value)) onChange(avatars[0].id);
  }, [avatars, onChange, value]);

  return (
    <fieldset className="avatarPicker">
      <legend>{t(legend)}</legend>
      <div>
        {avatars.map((avatar) => (
          <label key={avatar.id} title={t(avatar.label)}>
            <input
              type="radio"
              name="profile-avatar"
              value={avatar.id}
              checked={value === avatar.id}
              onChange={() => onChange(avatar.id)}
            />
            <ProfileAvatar avatarId={avatar.id} />
            <span>{t(avatar.label)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
