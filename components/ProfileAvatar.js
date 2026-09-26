import Image from "next/image";
import { profileAvatarSrc } from "../lib/profiles/avatars.js";

export default function ProfileAvatar({ avatarId, label = "", size = "medium" }) {
  const imageSize = size === "small" ? "34px" : size === "large" ? "126px" : "72px";
  return (
    <span
      className={`profileAvatar profileAvatar-${size}`}
      role={label ? "img" : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
    >
      <Image
        src={profileAvatarSrc(avatarId)}
        alt=""
        fill
        sizes={imageSize}
        loading={size === "large" ? "eager" : undefined}
      />
    </span>
  );
}
