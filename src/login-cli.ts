#!/usr/bin/env node
/**
 * CLI login, same as the MCP `login` tool: opens the Nextcloud login page in
 * the browser, you sign in, the app password is saved to
 * ~/.config/nextcloud-mcp/credentials.json.
 *
 *   npm run login -- --server https://cloud.example.com   first sign-in
 *   npm run login                                    sign in again to the saved server
 *   npm run login -- --user <LOGIN> --password <APP_PASSWORD>   save an app password made by hand
 */

import { CONFIG_DIR, loadCredentials, normalizeServerUrl, saveCredentials } from "./credentials.js";
import { fetchUserId, openInBrowser, startLoginFlow } from "./login-flow.js";

/** Value following a `--flag` on the command line, if present. */
function readFlag(flagName: string): string | undefined {
  const flagIndex = process.argv.indexOf(flagName);
  return flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
}

const serverFlag = readFlag("--server");
const serverUrl = serverFlag ? normalizeServerUrl(serverFlag) : loadCredentials().serverUrl;
if (!serverUrl) {
  console.error("Pass the server: npm run login -- --server https://cloud.example.com");
  process.exit(1);
}
const manualUser = readFlag("--user");
const manualPassword = readFlag("--password");

try {
  // Manual mode: nothing to open, just verify and store what the user created
  if (manualUser && manualPassword) {
    const credentials = { serverUrl, loginName: manualUser, appPassword: manualPassword };
    const userId = await fetchUserId(credentials);
    saveCredentials({ ...credentials, userId });
    console.error(`Saved to ${CONFIG_DIR}/credentials.json (user ${userId})`);
    process.exit(0);
  }

  const flow = await startLoginFlow(serverUrl);
  openInBrowser(flow.loginUrl);
  console.error(`Sign in in the browser. If it did not open, go to:\n${flow.loginUrl}\n`);
  const { userId } = await flow.completion;
  console.error(`Saved to ${CONFIG_DIR}/credentials.json (user ${userId})`);
  process.exit(0);
} catch (error) {
  console.error(`Error: ${(error as Error).message}`);
  process.exit(1);
}
