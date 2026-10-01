import { fetchUpstream } from "../../../lib/http";
import { ZNMA_CLIENT_ID } from "./config";
import type { NintendoAccountToken } from "./types";

const NA_TOKEN_URL = "https://accounts.nintendo.com/connect/1.0.0/api/token";

/**
 * Exchange the Parental Controls session token for the `id_token` znma's
 * action routes take as their bearer. The `access_token` in the same
 * response is for accounts.nintendo.com and is not used — the account
 * identity znma reports comes from `fetchUser`, which carries more.
 *
 * No f-token / imink / nxapi status service is involved: unlike the NSO
 * (coral) API, the Parental Controls API needs no request signing.
 */
export async function fetchIdToken(sessionToken: string): Promise<string> {
  const response = await fetchUpstream(NA_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 8.0.0)",
    },
    body: JSON.stringify({
      client_id: ZNMA_CLIENT_ID,
      session_token: sessionToken,
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer-session-token",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Nintendo Account token exchange failed (${response.status}): ${body}`);
  }

  const token = (await response.json()) as NintendoAccountToken;
  if (!token.id_token) {
    throw new Error("Nintendo Account token response missing id_token");
  }
  return token.id_token;
}
