/**
 * Nintendo Parental Controls (znma) API types — v2/v3 action routes.
 *
 * Shapes are transcribed from live responses; optional fields are the ones
 * Nintendo actually omits (a Switch 1 device carries no `platformGeneration`,
 * a day with no play carries no `players`).
 */

export interface MoonError {
  type: string;
  status: number;
  errorCode: string;
  title: string;
  detail: string;
  instance: string;
}

export interface NintendoAccountToken {
  scope?: string[];
  token_type?: string;
  id_token: string;
  access_token?: string;
  expires_in?: number;
}

/** Five-size image bag used for game art. */
export interface ImageUri {
  extraSmall?: string;
  small?: string;
  medium?: string;
  large?: string;
  extraLarge?: string;
}

export interface UserResponse {
  user: MoonUser;
}

export interface MoonUser {
  nintendoAccountId: string;
  nickname: string;
  country?: string;
  language?: string;
  miiUri?: ImageUri;
}

export interface OwnedDevicesResponse {
  ownedDevices: OwnedDevice[];
}

export interface OwnedDevice {
  deviceId: string;
  label: string;
  device: OwnedDeviceInfo;
  parentalControlSettingStatus?: string;
  hasNewMonthlySummary?: boolean;
  hasFirstDailySummary?: boolean;
  /** Pairing time, epoch seconds. */
  createdAt?: number;
}

export interface OwnedDeviceInfo {
  id: string;
  region?: string;
  serialNumber?: string;
  synchronizedUnlockCode?: string;
  extraPlayingTime?: number | null;
  platformGeneration?: string;
  externalNickname?: string;
  iconUri?: {
    lightTheme?: { small?: string; middle?: string };
    darkTheme?: { small?: string; middle?: string };
  };
}

export interface DailySummariesResponse {
  dailySummaries: DailySummary[];
  /** Epoch seconds of Nintendo's last recalculation. */
  lastUpdatedAt?: number;
  friendships?: Record<string, unknown>;
}

export interface DailySummary {
  date: string;
  /** ACHIEVED | CALCULATING | … — CALCULATING means the day is still open. */
  result: string;
  /** Minutes (znma v2 unit — not seconds). */
  playingTime: number;
  miscTime: number;
  exceededTime?: number;
  disabledTime?: number;
  timeZoneUtcOffsetSeconds?: number;
  events?: Record<string, unknown>;
  featuredGameIconURL?: ImageUri;
  players?: DailySummaryPlayer[];
}

export interface DailySummaryPlayer {
  profile?: {
    playerId: string;
    nickname: string;
    imageUri?: string;
    nsaId?: string;
  };
  playingTime?: number;
  playedGames?: PlayedGame[];
}

export interface PlayedGame {
  applicationId?: string;
  /** Minutes (znma v2 unit — not seconds). */
  playingTime: number;
  meta?: {
    applicationId?: string;
    title?: string;
    imageUri?: ImageUri;
    hasUgc?: boolean;
    shopUri?: string;
  };
}

export interface ParentalControlSettingResponse {
  parentalControlSetting: ParentalControlSetting;
}

/**
 * The setting document. Its `whitelistedApplicationList` is the only place
 * `firstPlayDate` appears anywhere in the API, which is why sync reads it.
 */
export interface ParentalControlSetting {
  deviceId: string;
  unlockCode?: string;
  functionalRestrictionLevel?: string;
  customSettings?: Record<string, unknown>;
  playTimerRegulations?: Record<string, unknown>;
  whitelistedApplicationList?: WhitelistedApplication[];
  etag?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface WhitelistedApplication {
  applicationId: string;
  title?: string;
  imageUri?: string;
  firstPlayDate?: string | null;
  safeLaunch?: string;
}

export function applicationId(game: PlayedGame): string | null {
  return game.applicationId ?? game.meta?.applicationId ?? null;
}
