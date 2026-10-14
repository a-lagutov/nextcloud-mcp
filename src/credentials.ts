/**
 * Credential store: ~/.config/nextcloud-mcp/credentials.json (chmod 600).
 *
 * Independent of the shell and of the MCP client config. Environment
 * variables (NEXTCLOUD_URL, NEXTCLOUD_USER, NEXTCLOUD_APP_PASSWORD) still
 * take precedence when set.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".config", "nextcloud-mcp");
const CREDENTIALS_FILE = join(CONFIG_DIR, "credentials.json");

export interface Credentials {
  /** Base URL of the Nextcloud server, without a trailing slash */
  serverUrl?: string;
  /** Login name for Basic auth (what Login Flow v2 returns) */
  loginName?: string;
  /** App password issued by Login Flow v2 or created in personal settings */
  appPassword?: string;
  /** Internal user ID used in WebDAV paths; may differ from the login name with SSO */
  userId?: string;
}

/** Read the stored credentials file; a missing or broken file counts as empty. */
function readStoredCredentials(): Credentials {
  if (!existsSync(CREDENTIALS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CREDENTIALS_FILE, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Strip trailing slashes and any path after the host part of a server URL,
 * so a pasted page link like https://host/apps/files/... still works.
 * @param url - server URL or any page URL of the server
 */
export function normalizeServerUrl(url: string): string {
  const parsed = new URL(url.trim());
  // Nextcloud may live under a sub-path: keep everything before index.php / apps / remote.php
  const basePath = parsed.pathname.split(/\/(?:index\.php|apps|remote\.php|ocs|login)(?:\/|$)/)[0];
  return `${parsed.origin}${basePath}`.replace(/\/+$/, "");
}

/**
 * Effective credentials: environment variables override the stored file.
 * Read on every call so a login in another process is picked up.
 */
export function loadCredentials(): Credentials {
  const stored = readStoredCredentials();
  const environmentUser = process.env.NEXTCLOUD_USER;
  const serverUrl = process.env.NEXTCLOUD_URL || stored.serverUrl;
  return {
    serverUrl: serverUrl ? normalizeServerUrl(serverUrl) : undefined,
    loginName: environmentUser || stored.loginName,
    appPassword: process.env.NEXTCLOUD_APP_PASSWORD || stored.appPassword,
    // A user from the environment invalidates the stored user ID of another account;
    // without SSO the user ID equals the login name
    userId: environmentUser ? process.env.NEXTCLOUD_USER_ID || environmentUser : stored.userId,
  };
}

/**
 * Merge values into the stored credentials file.
 * @param updates - fields to set; others are kept
 */
export function saveCredentials(updates: Credentials): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const merged = { ...readStoredCredentials(), ...updates };
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
  // writeFileSync keeps the old mode of an existing file
  chmodSync(CREDENTIALS_FILE, 0o600);
}
