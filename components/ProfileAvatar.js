import { profileAvatar } from "../lib/profiles/avatars.js";

export default function ProfileAvatar({ avatarId, label = "", size = "medium" }) {
  const avatar = profileAvatar(avatarId);
  return (
    <span
      className={`profileAvatar profileAvatar-${avatar.id} profileAvatar-${size}`}
      role={label ? "img" : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
    >
      <span>{avatar.symbol}</span>
    </span>
  );
}
