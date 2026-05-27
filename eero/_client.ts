import { z } from "npm:zod@4.3.6";

/**
 * Shared eero cloud API client.
 *
 * All eero management goes through their cloud at https://api-user.e2ro.com/2.2.
 * There is no local management interface on eero hardware.
 *
 * Auth is SMS/email OTP:
 *   1. POST /login with phone/email → triggers SMS
 *   2. POST /login/verify with code → returns session token
 *   3. All requests use Cookie: s=<token>
 *   4. On 401 with error.session.refresh, POST /login/refresh to get new token
 *
 * Session tokens are stored in the swamp vault for persistence across runs.
 */

const BASE_URL = "https://api-user.e2ro.com";
const API_VERSION = "2.2";

export const EeroGlobalArgsSchema = z.object({
  sessionToken: z
    .string()
    .default("")
    .meta({ sensitive: true })
    .describe(
      "Eero session token. Use: ${{ vault.get(eero, session-token) }}. Empty until auth-verify is run.",
    ),
});

export type EeroGlobalArgs = z.infer<typeof EeroGlobalArgsSchema>;

export interface EeroResponse {
  meta: { code: number; error?: string; server_time?: string };
  data: unknown;
}

export async function eeroApi(
  path: string,
  token: string,
  options?: {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    body?: Record<string, unknown>;
    apiVersion?: string;
  },
): Promise<EeroResponse> {
  const version = options?.apiVersion ?? API_VERSION;
  const url = `${BASE_URL}/${version}${path}`;
  const method = options?.method ?? "GET";

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
  };

  if (token) {
    headers["Cookie"] = `s=${token}`;
  }

  const fetchOptions: RequestInit = { method, headers };
  if (options?.body) {
    fetchOptions.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, fetchOptions);
  const json = (await response.json()) as EeroResponse;

  if (
    response.status === 401 &&
    json.meta?.error === "error.session.refresh"
  ) {
    throw new SessionRefreshError(
      "Session needs refresh. Run auth-refresh method.",
    );
  }

  if (
    response.status === 401 &&
    json.meta?.error === "error.session.invalid"
  ) {
    throw new SessionInvalidError(
      "Session invalid. Run auth-start and auth-verify to re-authenticate.",
    );
  }

  if (response.status === 429) {
    throw new Error("Eero API rate limit exceeded. Wait and try again.");
  }

  if (!response.ok && json.meta?.code !== 200) {
    throw new Error(
      `Eero API error ${response.status}: ${json.meta?.error ?? "unknown"}`,
    );
  }

  return json;
}

export class SessionRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionRefreshError";
  }
}

export class SessionInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionInvalidError";
  }
}

/**
 * Login step 1: Send verification code to phone/email.
 * Returns the user_token to use in step 2.
 */
export async function eeroLoginStart(
  login: string,
): Promise<string> {
  const response = await eeroApi("/login", "", {
    method: "POST",
    body: { login },
  });
  const data = response.data as Record<string, string>;
  return data.user_token;
}

/**
 * Login step 2: Verify the SMS/email code.
 * Returns the verified session token.
 */
export async function eeroLoginVerify(
  userToken: string,
  code: string,
): Promise<string> {
  const response = await eeroApi("/login/verify", userToken, {
    method: "POST",
    body: { code },
  });
  // After verification, the user_token becomes the session token
  const data = response.data as Record<string, string>;
  return data.user_token ?? userToken;
}

/**
 * Refresh an expired session token.
 */
export async function eeroLoginRefresh(
  token: string,
): Promise<string> {
  const response = await eeroApi("/login/refresh", token, {
    method: "POST",
  });
  const data = response.data as Record<string, string>;
  return data.user_token ?? token;
}

export function sanitizeId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
}
