import ProfileAvatar from "./ProfileAvatar.js";
import { PROFILE_AVATARS } from "../lib/profiles/avatars.js";

export default function AvatarPicker({ value, onChange, legend = "Choose an avatar" }) {
  return (
    <fieldset className="avatarPicker">
      <legend>{legend}</legend>
      <div>
        {PROFILE_AVATARS.map((avatar) => (
          <label key={avatar.id} title={avatar.label}>
            <input
              type="radio"
              name="profile-avatar"
              value={avatar.id}
              checked={value === avatar.id}
              onChange={() => onChange(avatar.id)}
            />
            <ProfileAvatar avatarId={avatar.id} />
            <span>{avatar.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
