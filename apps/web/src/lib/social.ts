/**
 * Social profile links for the homepage header.
 *
 * Configuration, same reasoning as `legal.ts`: an icon that links to the wrong
 * (or no) profile is worse than not showing it. Any URL left unset simply
 * hides that icon instead of linking nowhere.
 */

export interface SocialLinks {
  facebook: string | null;
  instagram: string | null;
  tiktok: string | null;
}

const orNull = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

export function socialLinks(): SocialLinks {
  return {
    facebook: orNull(process.env.SOCIAL_FACEBOOK_URL),
    instagram: orNull(process.env.SOCIAL_INSTAGRAM_URL),
    tiktok: orNull(process.env.SOCIAL_TIKTOK_URL),
  };
}
