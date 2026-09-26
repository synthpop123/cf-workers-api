import type { MoonClientConfig } from "./config";
import type {
  DailySummariesResponse,
  MoonError,
  OwnedDevicesResponse,
  ParentalControlSettingResponse,
  UserResponse,
} from "./types";

const ZNMA_URL = "https://app.lp1.znma.srv.nintendo.net";

export class MoonApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: MoonError
  ) {
    super(message);
    this.name = "MoonApiError";
  }
}

/**
 * The four read routes the Parental Controls app itself calls. Nintendo
 * exposes no monthly-summary route on this host (the `moonMonthlySummary`
 * scope notwithstanding), so daily summaries — a rolling window Nintendo
 * eventually drops — are the whole history surface. Keeping them is D1's job.
 */
export class MoonClient {
  constructor(
    private readonly idToken: string,
    private readonly config: MoonClientConfig
  ) {}

  getUser(): Promise<UserResponse> {
    return this.get<UserResponse>("/v2/actions/user/fetchUser");
  }

  getDevices(): Promise<OwnedDevicesResponse> {
    return this.get<OwnedDevicesResponse>("/v3/actions/user/fetchOwnedDevices");
  }

  getDailySummaries(deviceId: string): Promise<DailySummariesResponse> {
    return this.get<DailySummariesResponse>(
      `/v2/actions/playSummary/fetchDailySummaries?deviceId=${encodeURIComponent(deviceId)}`
    );
  }

  getParentalControlSetting(deviceId: string): Promise<ParentalControlSettingResponse> {
    return this.get<ParentalControlSettingResponse>(
      `/v3/actions/parentalControlSetting/fetchParentalControlSetting?deviceId=${encodeURIComponent(deviceId)}`
    );
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.idToken}`,
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Moon-App-Id": "com.nintendo.znma",
      "X-Moon-Os": "ANDROID",
      "X-Moon-Os-Version": "34",
      "X-Moon-Model": "Pixel 4 XL",
      "X-Moon-TimeZone": "Asia/Tokyo",
      "X-Moon-Os-Language": "ja-JP",
      "X-Moon-App-Language": "ja-JP",
      "X-Moon-App-Display-Version": this.config.version,
      "X-Moon-App-Internal-Version": this.config.build,
      "User-Agent": this.config.userAgent,
    };
  }

  private async get<T extends object>(path: string): Promise<T> {
    const response = await fetch(ZNMA_URL + path, { headers: this.headers() });

    if (response.status !== 200) {
      let body: MoonError | undefined;
      try {
        body = (await response.json()) as MoonError;
      } catch {
        // A non-JSON error body carries nothing worth surfacing.
      }
      throw new MoonApiError(
        body?.errorCode ?? body?.title ?? `Moon API ${response.status}`,
        response.status,
        body
      );
    }

    const data = (await response.json()) as T | MoonError;
    if ("errorCode" in data) {
      throw new MoonApiError(data.errorCode, data.status, data);
    }
    return data;
  }
}
