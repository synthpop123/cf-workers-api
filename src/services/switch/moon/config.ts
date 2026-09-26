export const ZNMA_CLIENT_ID = "54789befb391a838";

export interface MoonClientConfig {
  version: string;
  build: string;
  userAgent: string;
}

/** Current Parental Controls app identity (2.4.0 / build 660, March 2026). */
export const MOBILE_APP_VERSION = "2.4.0";
export const MOBILE_APP_BUILD = "660";

export const MOON_CLIENT_CONFIG: MoonClientConfig = {
  version: MOBILE_APP_VERSION,
  build: MOBILE_APP_BUILD,
  userAgent: `moon_ANDROID/${MOBILE_APP_VERSION} (com.nintendo.znma; build:${MOBILE_APP_BUILD}; ANDROID 34)`,
};
