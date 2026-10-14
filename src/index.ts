#!/usr/bin/env node

/**
 * Nextcloud MCP Server
 *
 * MCP server for a Nextcloud instance:
 * listing, search, upload, download, copy, move, delete, shares and public
 * links, favorites, trash bin.
 *
 * Starts without credentials; call the `login` tool to sign in.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadCredentials, normalizeServerUrl, saveCredentials, type Credentials } from "./credentials.js";
import { fetchUserId, openInBrowser, startLoginFlow } from "./login-flow.js";
import {
  NextcloudClient,
  NotLoggedInError,
  baseName,
  joinPath,
  normalizePath,
  parentPath,
  type NodeInfo,
  type Share,
} from "./nextcloud-client.js";
import { openLocalFile, runPool, walkLocalFolder } from "./local-file.js";

// ─── Init ───────────────────────────────────────────────

const client = new NextcloudClient(loadCredentials());

/** Login flow started by `login` and still waiting for the user, if any. */
let pendingLogin: { loginUrl: string; completion: Promise<Credentials> } | null = null;

const TRANSFER_CONCURRENCY = 4;
/** How long `login` waits for the user before returning and finishing in the background */
const LOGIN_WAIT_MS = 120_000;
const READ_TEXT_LIMIT = 200_000;

const server = new McpServer({
  name: "nextcloud",
  version: "1.0.0",
});

// ─── Helpers ────────────────────────────────────────────

/** Human-readable byte size. */
function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unitIndex = 0;
  let size = bytes;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

/** Short ISO-like local date from an HTTP date string. */
function formatDate(httpDate: string): string {
  const date = new Date(httpDate);
  return Number.isNaN(date.getTime()) ? httpDate : date.toISOString().slice(0, 16).replace("T", " ");
}

/** One-line description of a file or folder. */
function formatNode(node: NodeInfo): string {
  const icon = node.isDir ? "📁" : "📄";
  const favorite = node.isFavorite ? " ⭐" : "";
  return `${icon} ${node.name}${favorite} (${formatSize(node.size)}, ${formatDate(node.modified)}) — ${node.path}`;
}

/** Names of share types used by the OCS API. */
const SHARE_TYPE_NAMES: Record<number, string> = {
  0: "user",
  1: "group",
  3: "public link",
  4: "email",
  6: "federated",
  7: "circle",
  10: "talk room",
};

/** Permission bitmask to text, e.g. "read, update, create". */
function formatSharePermissions(permissions: number): string {
  const names = ["read", "update", "create", "delete", "share"];
  return names.filter((_, bitIndex) => permissions & (1 << bitIndex)).join(", ") || "none";
}

/** One-line description of a share. */
function formatShare(share: Share): string {
  const typeName = SHARE_TYPE_NAMES[share.share_type] ?? `type ${share.share_type}`;
  const target = share.share_type === 3 ? share.url : share.share_with_displayname || share.share_with;
  const details = [
    `id ${share.id}`,
    typeName,
    target ? `→ ${target}` : null,
    `owner ${share.displayname_owner}`,
    formatSharePermissions(share.permissions),
    share.expiration ? `expires ${share.expiration.slice(0, 10)}` : null,
    share.password ? "password" : null,
    share.label ? `label "${share.label}"` : null,
  ].filter(Boolean);
  const icon = share.item_type === "folder" ? "📁" : "📄";
  return `${icon} ${share.path} — ${details.join(", ")}`;
}

/** MCP text result. */
function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** Destination path: a trailing "/" means "into this folder, keep the source name". */
function resolveDestination(destination: string, sourceName: string): string {
  return destination.trim().endsWith("/") ? joinPath(normalizePath(destination), sourceName) : normalizePath(destination);
}

/**
 * Wrap a tool handler: picks up a login made elsewhere, and turns errors into
 * readable messages (with the pending login URL when not logged in).
 * @param handler - tool body
 */
function guarded<Args>(handler: (args: Args) => Promise<ReturnType<typeof textResult>>) {
  return async (args: Args) => {
    // A login through the CLI or another server process is picked up without a restart
    if (!client.isLoggedIn) client.setCredentials(loadCredentials());
    try {
      return await handler(args);
    } catch (error) {
      if (error instanceof NotLoggedInError && pendingLogin) {
        return textResult(`❌ Login is not finished yet. Open ${pendingLogin.loginUrl} and sign in, then retry.`);
      }
      return { ...textResult(`❌ ${(error as Error).message}`), isError: true };
    }
  };
}

// ─── Tool: login ────────────────────────────────────────

server.tool(
  "login",
  "Sign in to Nextcloud with Login Flow v2: opens the " +
    "server's login page in the default browser, the user signs in (SSO works), and an app " +
    "password is issued and saved. Waits up to 2 minutes, then keeps waiting in the background " +
    "and returns the login URL. Call this when other tools report that the user is not logged in. " +
    "Without a browser, pass `login_name` and `app_password` (Settings → Security → App passwords).",
  {
    server_url: z
      .string()
      .optional()
      .describe("Nextcloud URL (any page of it works). Required on the first login, then the saved one is used"),
    login_name: z.string().optional().describe("Login name for manual mode, no browser needed"),
    app_password: z.string().optional().describe("App password for manual mode, no browser needed"),
  },
  guarded(async ({ server_url, login_name, app_password }) => {
    const serverUrl = server_url ? normalizeServerUrl(server_url) : loadCredentials().serverUrl;
    if (!serverUrl) throw new Error("Pass `server_url` — the address of your Nextcloud, e.g. https://cloud.example.com");

    // Manual mode: the user created an app password by hand
    if (login_name && app_password) {
      const credentials = { serverUrl, loginName: login_name.trim(), appPassword: app_password.trim() };
      const userId = await fetchUserId(credentials);
      saveCredentials({ ...credentials, userId });
      client.setCredentials({ ...credentials, userId });
      return textResult(`✅ Saved. Logged in to ${serverUrl} as ${userId}.`);
    }

    const flow = await startLoginFlow(serverUrl);
    pendingLogin = flow;
    flow.completion.then(
      (credentials) => {
        client.setCredentials(credentials);
        if (pendingLogin === flow) pendingLogin = null;
      },
      () => {
        if (pendingLogin === flow) pendingLogin = null;
      }
    );
    openInBrowser(flow.loginUrl);

    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), LOGIN_WAIT_MS));
    const credentials = await Promise.race([flow.completion, timeout]);
    if (credentials) {
      return textResult(`✅ Logged in to ${serverUrl} as ${credentials.userId}.`);
    }
    return textResult(
      `⏳ Waiting for sign-in. Open this page if the browser did not open it:\n${flow.loginUrl}\n` +
        "The login finishes by itself once you sign in (link valid for 20 minutes)."
    );
  })
);

// ─── Tool: disk_info ────────────────────────────────────

server.tool(
  "disk_info",
  "Storage info of the Nextcloud account: used and available quota, server and user",
  {},
  guarded(async () => {
    const root = await client.stat("/");
    const used = root.quotaUsed ?? root.size;
    const available = root.quotaAvailable;
    // Nextcloud reports -3 for "unlimited" and -1/-2 for "unknown"
    const availableText = available === undefined || available < 0 ? "unlimited" : formatSize(available);
    return textResult(
      [
        `💽 ${client.serverUrl} — user ${client.userId}`,
        `Used:      ${formatSize(used)}`,
        `Available: ${availableText}`,
      ].join("\n")
    );
  })
);

// ─── Tool: list_files ───────────────────────────────────

server.tool(
  "list_files",
  "List files and folders at a path. Paths are relative to the user's files root, e.g. '/' or " +
    "'/Projects'. A Files app link (…/apps/files/files/123?dir=/folder) works too.",
  {
    path: z.string().default("/").describe("Folder path or Files app URL"),
    limit: z.number().optional().default(50).describe("Max items to return (default 50)"),
    offset: z.number().optional().default(0).describe("Offset for pagination"),
    sort: z
      .enum(["name", "-name", "modified", "-modified", "size", "-size"])
      .optional()
      .default("name")
      .describe("Sort field; '-' prefix = descending. Folders always come first"),
  },
  guarded(async ({ path, limit, offset, sort }) => {
    const [self, ...children] = await client.list(normalizePath(path));
    if (!self.isDir) return textResult(formatNode(self));

    const field = sort.replace("-", "") as "name" | "modified" | "size";
    const direction = sort.startsWith("-") ? -1 : 1;
    children.sort((first, second) => {
      if (first.isDir !== second.isDir) return first.isDir ? -1 : 1;
      if (field === "size") return (first.size - second.size) * direction;
      if (field === "modified") {
        return (new Date(first.modified).getTime() - new Date(second.modified).getTime()) * direction;
      }
      return first.name.localeCompare(second.name, undefined, { numeric: true }) * direction;
    });
    const page = children.slice(offset, offset + limit);
    const range = page.length ? `, showing ${offset + 1}–${offset + page.length}` : "";
    return textResult(
      [`📂 ${self.path} (${children.length} items${range})`, "", ...page.map(formatNode)].join("\n")
    );
  })
);

// ─── Tool: get_file_info ────────────────────────────────

server.tool(
  "get_file_info",
  "Detailed metadata of a file or folder: size, dates, type, file ID, permissions, web link",
  {
    path: z.string().describe("Path, e.g. '/Projects/logo.svg'"),
  },
  guarded(async ({ path }) => {
    const node = await client.stat(normalizePath(path));
    const lines = [
      `Name:        ${node.name}`,
      `Type:        ${node.isDir ? "folder" : "file"}`,
      `Path:        ${node.path}`,
      `Size:        ${formatSize(node.size)}`,
      `Modified:    ${formatDate(node.modified)}`,
    ];
    if (node.contentType) lines.push(`MIME:        ${node.contentType}`);
    if (node.fileId) lines.push(`File ID:     ${node.fileId}`);
    if (node.owner) lines.push(`Owner:       ${node.owner}`);
    if (node.permissions) lines.push(`Permissions: ${node.permissions}`);
    if (node.isFavorite) lines.push(`Favorite:    yes`);
    const folder = node.isDir ? node.path : parentPath(node.path);
    lines.push(`Web:         ${client.webUrl(folder)}`);
    return textResult(lines.join("\n"));
  })
);

// ─── Tool: search_files ─────────────────────────────────

server.tool(
  "search_files",
  "Server-side search by name (case-insensitive substring) in a folder tree, newest first. " +
    "Optional MIME filter. Without `query` lists everything matching the filter.",
  {
    query: z.string().optional().describe("Part of the name to look for"),
    folder: z.string().optional().default("/").describe("Folder to search in recursively (default: everything)"),
    mime_type: z
      .string()
      .optional()
      .describe("MIME filter, '%' is a wildcard: 'image/%', 'application/pdf', 'httpd/unix-directory' (folders)"),
    limit: z.number().optional().default(50).describe("Max results (default 50, up to 500)"),
  },
  guarded(async ({ query, folder, mime_type, limit }) => {
    const results = await client.search({
      query,
      folder: normalizePath(folder),
      mimeType: mime_type,
      limit: Math.min(limit, 500),
    });
    if (results.length === 0) return textResult("Nothing found.");
    return textResult([`🔍 ${results.length} found`, "", ...results.map(formatNode)].join("\n"));
  })
);

// ─── Tool: recent_files ─────────────────────────────────

server.tool(
  "recent_files",
  "Files modified recently, newest first (server-side search by modification date)",
  {
    days: z.number().optional().default(7).describe("Look back this many days (default 7)"),
    folder: z.string().optional().default("/").describe("Folder to look in recursively"),
    limit: z.number().optional().default(30).describe("Max results (default 30)"),
  },
  guarded(async ({ days, folder, limit }) => {
    const results = await client.search({
      folder: normalizePath(folder),
      modifiedAfter: new Date(Date.now() - days * 86_400_000),
      filesOnly: true,
      limit: Math.min(limit, 500),
    });
    const files = results.filter((node) => !node.isDir);
    if (files.length === 0) return textResult(`No files modified in the last ${days} days.`);
    return textResult(files.map(formatNode).join("\n"));
  })
);

// ─── Tool: create_folder ────────────────────────────────

server.tool(
  "create_folder",
  "Create a folder (missing parent folders are created too)",
  {
    path: z.string().describe("Folder path, e.g. '/Projects/new'"),
  },
  guarded(async ({ path }) => {
    const folderPath = normalizePath(path);
    await client.ensureFolder(folderPath);
    return textResult(`✅ Folder ready: ${folderPath}`);
  })
);

// ─── Tool: delete ───────────────────────────────────────

server.tool(
  "delete",
  "Delete files or folders (they go to the trash bin of their owner; restore with restore_from_trash)",
  {
    paths: z.array(z.string()).min(1).describe("Paths to delete"),
  },
  guarded(async ({ paths }) => {
    const lines: string[] = [];
    for (const path of paths) {
      const normalized = normalizePath(path);
      if (normalized === "/") {
        lines.push("❌ / — refusing to delete the root");
        continue;
      }
      try {
        await client.delete(normalized);
        lines.push(`🗑️ ${normalized}`);
      } catch (error) {
        lines.push(`❌ ${normalized} — ${(error as Error).message}`);
      }
    }
    return textResult(lines.join("\n"));
  })
);

// ─── Tools: copy / move ─────────────────────────────────

for (const [toolName, method, verb] of [
  ["copy", "COPY", "Copied"],
  ["move", "MOVE", "Moved"],
] as const) {
  server.tool(
    toolName,
    `${toolName === "copy" ? "Copy" : "Move or rename"} a file or folder. A destination ending ` +
      "with '/' means 'into this folder, same name'.",
    {
      from: z.string().describe("Source path"),
      to: z.string().describe("Destination path, or folder ending with '/'"),
      overwrite: z.boolean().optional().default(false).describe("Replace an existing destination"),
    },
    guarded(async ({ from, to, overwrite }) => {
      const sourcePath = normalizePath(from);
      const destinationPath = resolveDestination(to, baseName(sourcePath));
      await client.transfer(method, sourcePath, destinationPath, overwrite);
      return textResult(`✅ ${verb}: ${sourcePath} → ${destinationPath}`);
    })
  );
}

// ─── Tool: upload_file ──────────────────────────────────

server.tool(
  "upload_file",
  "Upload a local file. Big files are uploaded in chunks. A destination ending with '/' keeps the local name.",
  {
    local_path: z.string().describe("Absolute path of the file on this machine"),
    path: z.string().describe("Destination path, or folder ending with '/'"),
    overwrite: z.boolean().optional().default(false).describe("Replace an existing file"),
  },
  guarded(async ({ local_path, path, overwrite }) => {
    const file = await openLocalFile(local_path);
    const destinationPath = resolveDestination(path, file.name);
    if (!overwrite && (await client.exists(destinationPath))) {
      throw new Error(`Already exists: ${destinationPath} (pass overwrite=true to replace)`);
    }
    await client.ensureFolder(parentPath(destinationPath));
    await client.upload(file, destinationPath);
    return textResult(`✅ Uploaded ${formatSize(file.size)} → ${destinationPath}`);
  })
);

// ─── Tool: upload_folder ────────────────────────────────

server.tool(
  "upload_folder",
  "Upload a whole local folder recursively in one call (parallel). The folder is created inside " +
    "`path` under its own name. Existing files are skipped unless overwrite=true.",
  {
    local_path: z.string().describe("Absolute path of the folder on this machine"),
    path: z.string().describe("Destination parent folder, e.g. '/Projects'"),
    overwrite: z.boolean().optional().default(false).describe("Replace files that already exist"),
  },
  guarded(async ({ local_path, path, overwrite }) => {
    if (!statSync(local_path).isDirectory()) throw new Error(`Not a folder: ${local_path}`);
    const remoteRoot = joinPath(normalizePath(path), baseName(local_path.replace(/[\\/]+$/, "").replace(/\\/g, "/")));
    const { folders, files } = await walkLocalFolder(local_path);

    await client.ensureFolder(remoteRoot);
    // Parents come first in `folders`, so sequential creation never hits a missing parent
    for (const folder of folders) await client.ensureFolder(joinPath(remoteRoot, folder));

    let uploadedCount = 0;
    let skippedCount = 0;
    let uploadedBytes = 0;
    const failures: string[] = [];
    await runPool(files, TRANSFER_CONCURRENCY, async (relativePath) => {
      const remotePath = joinPath(remoteRoot, relativePath);
      try {
        if (!overwrite && (await client.exists(remotePath))) {
          skippedCount++;
          return;
        }
        const file = await openLocalFile(join(local_path, relativePath));
        await client.upload(file, remotePath);
        uploadedCount++;
        uploadedBytes += file.size;
      } catch (error) {
        failures.push(`${relativePath}: ${(error as Error).message}`);
      }
    });

    const summary = [
      `✅ ${remoteRoot}: uploaded ${uploadedCount} files (${formatSize(uploadedBytes)}), ` +
        `skipped ${skippedCount} existing, ${folders.length + 1} folders.`,
    ];
    if (failures.length) summary.push(`❌ ${failures.length} failed:`, ...failures.slice(0, 20));
    return textResult(summary.join("\n"));
  })
);

// ─── Tool: download ─────────────────────────────────────

server.tool(
  "download",
  "Download a file or a whole folder (recursively, parallel) to this machine. " +
    "`local_path` is the target file, or an existing folder / path ending with '/' to download into.",
  {
    path: z.string().describe("File or folder path on the server"),
    local_path: z.string().describe("Absolute local destination"),
    overwrite: z.boolean().optional().default(false).describe("Replace local files that already exist"),
  },
  guarded(async ({ path, local_path, overwrite }) => {
    const remotePath = normalizePath(path);
    const node = await client.stat(remotePath);
    const isLocalFolder =
      /[\\/]$/.test(local_path) || (existsSync(local_path) && statSync(local_path).isDirectory());
    const target = isLocalFolder ? join(local_path, node.name) : local_path;

    if (!node.isDir) {
      if (!overwrite && existsSync(target)) throw new Error(`Already exists: ${target} (pass overwrite=true)`);
      await client.download(remotePath, target);
      return textResult(`✅ Downloaded ${formatSize(node.size)} → ${target}`);
    }

    // Walk the remote tree breadth-first, collecting files to fetch
    const files: NodeInfo[] = [];
    const queue = [remotePath];
    while (queue.length) {
      const [, ...children] = await client.list(queue.shift()!);
      for (const child of children) (child.isDir ? queue.push(child.path) : files.push(child));
    }

    let downloadedCount = 0;
    let skippedCount = 0;
    const failures: string[] = [];
    await runPool(files, TRANSFER_CONCURRENCY, async (file) => {
      const localFile = join(target, ...file.path.slice(remotePath.length + 1).split("/"));
      try {
        if (!overwrite && existsSync(localFile)) {
          skippedCount++;
          return;
        }
        await client.download(file.path, localFile);
        downloadedCount++;
      } catch (error) {
        failures.push(`${file.path}: ${(error as Error).message}`);
      }
    });
    const summary = [
      `✅ ${target}: downloaded ${downloadedCount} files (${formatSize(node.size)} total), skipped ${skippedCount} existing.`,
    ];
    if (failures.length) summary.push(`❌ ${failures.length} failed:`, ...failures.slice(0, 20));
    return textResult(summary.join("\n"));
  })
);

// ─── Tool: read_file ────────────────────────────────────

server.tool(
  "read_file",
  "Read a text file (txt, md, json, csv, svg, …) and return its contents (first 200 KB)",
  {
    path: z.string().describe("File path on the server"),
  },
  guarded(async ({ path }) => {
    const remotePath = normalizePath(path);
    const text = await client.readText(remotePath);
    const truncated = text.length > READ_TEXT_LIMIT ? `\n\n… truncated, ${text.length} chars total` : "";
    return textResult(text.slice(0, READ_TEXT_LIMIT) + truncated);
  })
);

// ─── Tool: set_favorite ─────────────────────────────────

server.tool(
  "set_favorite",
  "Mark or unmark a file/folder as favorite",
  {
    path: z.string().describe("File or folder path"),
    favorite: z.boolean().optional().default(true).describe("true to add, false to remove"),
  },
  guarded(async ({ path, favorite }) => {
    const normalized = normalizePath(path);
    await client.setFavorite(normalized, favorite);
    return textResult(`${favorite ? "⭐ Added to" : "Removed from"} favorites: ${normalized}`);
  })
);

// ─── Tool: create_share ─────────────────────────────────

server.tool(
  "create_share",
  "Share a file or folder: a public link (default), or with a user, group or email address. " +
    "Returns the link for public shares.",
  {
    path: z.string().describe("File or folder path"),
    type: z.enum(["link", "user", "group", "email"]).optional().default("link").describe("Share type"),
    share_with: z.string().optional().describe("User ID, group ID or email (not for links)"),
    permissions: z
      .enum(["read", "edit", "upload_only"])
      .optional()
      .default("read")
      .describe("read; edit (read+update+create+delete); upload_only (file drop, folders and links only)"),
    password: z.string().optional().describe("Password for a public link"),
    expire_date: z.string().optional().describe("Expiry date YYYY-MM-DD"),
    label: z.string().optional().describe("Label of a public link"),
    note: z.string().optional().describe("Note for the recipient"),
  },
  guarded(async ({ path, type, share_with, permissions, password, expire_date, label, note }) => {
    const shareTypes = { user: 0, group: 1, link: 3, email: 4 } as const;
    if (type !== "link" && !share_with) throw new Error(`share_with is required for type "${type}"`);
    const permissionBits = { read: 1, edit: 15, upload_only: 4 }[permissions];
    const share = await client.createShare({
      path: normalizePath(path),
      shareType: shareTypes[type],
      shareWith: share_with,
      permissions: permissionBits,
      password,
      expireDate: expire_date,
      label,
      note,
    });
    return textResult(`✅ ${formatShare(share)}`);
  })
);

// ─── Tool: list_shares ──────────────────────────────────

server.tool(
  "list_shares",
  "List shares made by the user: all, or of one path; with `subfiles` also every share " +
    "inside a folder at any depth",
  {
    path: z.string().optional().describe("Only shares of this file/folder"),
    subfiles: z
      .boolean()
      .optional()
      .default(false)
      .describe("With `path` on a folder: also shares of everything inside it, at any depth"),
  },
  guarded(async ({ path, subfiles }) => {
    let shares: Share[];
    if (path && subfiles) {
      // The OCS `subfiles` flag sees direct children only: filter the full list by path prefix instead
      const folderPath = normalizePath(path);
      shares = (await client.listShares()).filter(
        (share) => share.path === folderPath || share.path.startsWith(`${folderPath === "/" ? "" : folderPath}/`)
      );
    } else {
      shares = await client.listShares({ path: path ? normalizePath(path) : undefined });
    }
    if (shares.length === 0) return textResult("No shares.");
    return textResult(shares.map(formatShare).join("\n"));
  })
);

// ─── Tool: list_shared_with_me ──────────────────────────

server.tool(
  "list_shared_with_me",
  "List files and folders other users shared with the current user (paths where they appear)",
  {},
  guarded(async () => {
    const shares = await client.listShares({ sharedWithMe: true });
    if (shares.length === 0) return textResult("Nothing is shared with you.");
    return textResult(shares.map(formatShare).join("\n"));
  })
);

// ─── Tool: update_share ─────────────────────────────────

server.tool(
  "update_share",
  "Change a share: permissions, password, expiry date, label or note (ID from list_shares)",
  {
    share_id: z.string().describe("Share ID"),
    permissions: z.enum(["read", "edit", "upload_only"]).optional().describe("New permissions"),
    password: z.string().optional().describe("New password of a public link ('' removes it)"),
    expire_date: z.string().optional().describe("New expiry YYYY-MM-DD ('' removes it)"),
    label: z.string().optional().describe("New label"),
    note: z.string().optional().describe("New note"),
  },
  guarded(async ({ share_id, permissions, password, expire_date, label, note }) => {
    let share: Share | null = null;
    // The OCS API takes one attribute per update call
    const updates: [string, string | undefined][] = [
      ["permissions", permissions && String({ read: 1, edit: 15, upload_only: 4 }[permissions])],
      ["password", password],
      ["expireDate", expire_date],
      ["label", label],
      ["note", note],
    ];
    for (const [key, value] of updates) {
      if (value !== undefined) share = await client.updateShare(share_id, { [key]: value });
    }
    if (!share) throw new Error("Nothing to update");
    return textResult(`✅ ${formatShare(share)}`);
  })
);

// ─── Tool: delete_share ─────────────────────────────────

server.tool(
  "delete_share",
  "Remove a share or public link (ID from list_shares); the file itself stays",
  {
    share_id: z.string().describe("Share ID"),
  },
  guarded(async ({ share_id }) => {
    await client.deleteShare(share_id);
    return textResult(`✅ Share ${share_id} removed`);
  })
);

// ─── Tools: trash bin ───────────────────────────────────

server.tool(
  "list_trash",
  "List items in the trash bin, newest first",
  {
    limit: z.number().optional().default(30).describe("Max items (default 30)"),
  },
  guarded(async ({ limit }) => {
    const items = await client.listTrash();
    if (items.length === 0) return textResult("Trash is empty.");
    const lines = items.slice(0, limit).map(
      (item) =>
        `${item.isDir ? "📁" : "📄"} ${item.originalName} (${formatSize(item.size)}, deleted ` +
        `${item.deletedAt.toISOString().slice(0, 16).replace("T", " ")}) — from /${item.originalLocation} — id: ${item.trashName}`
    );
    return textResult([`🗑️ ${items.length} items`, "", ...lines].join("\n"));
  })
);

server.tool(
  "restore_from_trash",
  "Restore an item from the trash bin to its original location (id from list_trash)",
  {
    trash_id: z.string().describe("Trash item id, e.g. 'report.pdf.d1712345678'"),
  },
  guarded(async ({ trash_id }) => {
    await client.restoreFromTrash(trash_id);
    return textResult(`✅ Restored ${trash_id}`);
  })
);

server.tool(
  "clear_trash",
  "Permanently delete one item from the trash bin, or empty the whole trash bin. Irreversible.",
  {
    trash_id: z.string().optional().describe("Trash item id; omit to empty the whole trash bin"),
  },
  guarded(async ({ trash_id }) => {
    await client.deleteFromTrash(trash_id);
    return textResult(trash_id ? `✅ Permanently deleted ${trash_id}` : "✅ Trash emptied");
  })
);

// ─── Start ──────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
