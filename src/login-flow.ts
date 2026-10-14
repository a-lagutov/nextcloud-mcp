/**
 * Nextcloud Login Flow v2: the server issues a one-time login page, the user
 * signs in there in any browser (SSO included), and the server hands an app
 * password to whoever polls with the flow token. No browser automation needed.
 *
 * https://docs.nextcloud.com/server/latest/developer_manual/client_apis/LoginFlow/index.html
 */

import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { saveCredentials, type Credentials } from "./credentials.js";

const POLL_INTERVAL_MS = 2_000;
/** Nextcloud expires a flow after 20 minutes */
const FLOW_LIFETIME_MS = 20 * 60_000;

/** A started login flow. */
export interface LoginFlow {
  /** Page the user must open to sign in */
  loginUrl: string;
  /** Resolves with saved credentials once the user signs in; rejects on expiry */
  completion: Promise<Credentials>;
}

/** Sleep helper for polling loops. */
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Open a URL in the default browser of this machine. Failures are ignored:
 * the URL is also returned to the user to open by hand.
 * @param url - page to open
 */
export function openInBrowser(url: string): void {
  const [command, ...args] =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // No browser available (Docker, SSH): the user opens the URL manually
  }
}

/**
 * Ask the server for the internal user ID of an account (WebDAV paths use it).
 * @param credentials - server URL, login name and app password
 */
export async function fetchUserId(credentials: Required<Omit<Credentials, "userId">>): Promise<string> {
  const response = await fetch(`${credentials.serverUrl}/ocs/v2.php/cloud/user?format=json`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${credentials.loginName}:${credentials.appPassword}`).toString("base64")}`,
      "OCS-APIRequest": "true",
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Credentials rejected by ${credentials.serverUrl} (HTTP ${response.status})`);
  }
  const body = (await response.json()) as { ocs: { data: { id: string } } };
  return body.ocs.data.id;
}

/**
 * Start Login Flow v2 and poll for the result in the background.
 * @param serverUrl - Nextcloud base URL
 * @returns the login page URL and a promise of the saved credentials
 */
export async function startLoginFlow(serverUrl: string): Promise<LoginFlow> {
  // The User-Agent becomes the name of the app password in the user's security settings
  const userAgent = `nextcloud-mcp (${hostname()})`;
  const response = await fetch(`${serverUrl}/index.php/login/v2`, {
    method: "POST",
    headers: { "User-Agent": userAgent, Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Login Flow v2 is not available on ${serverUrl} (HTTP ${response.status})`);
  }
  const flow = (await response.json()) as {
    poll: { token: string; endpoint: string };
    login: string;
  };

  const completion = (async (): Promise<Credentials> => {
    const deadline = Date.now() + FLOW_LIFETIME_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const pollResponse = await fetch(flow.poll.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": userAgent },
        body: new URLSearchParams({ token: flow.poll.token }),
      }).catch(() => null);
      // 404 means the user has not finished signing in yet; network errors are retried too
      if (!pollResponse || pollResponse.status === 404) continue;
      if (!pollResponse.ok) throw new Error(`Login poll failed with HTTP ${pollResponse.status}`);

      const result = (await pollResponse.json()) as {
        server: string;
        loginName: string;
        appPassword: string;
      };
      const credentials = {
        serverUrl,
        loginName: result.loginName,
        appPassword: result.appPassword,
      };
      const userId = await fetchUserId(credentials);
      saveCredentials({ ...credentials, userId });
      return { ...credentials, userId };
    }
    throw new Error("Login was not completed in 20 minutes — call `login` again");
  })();
  // A rejection nobody awaits yet must not crash the server
  completion.catch(() => undefined);

  return { loginUrl: flow.login, completion };
}
