/**
 * Nextcloud client: files over WebDAV (PROPFIND, SEARCH, MKCOL, MOVE, COPY, PUT, GET,
 * DELETE, chunked upload v2, trash bin) and shares over the OCS files_sharing API.
 * Authenticates with Basic auth: login name + app password.
 */

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { XMLParser } from "fast-xml-parser";
import type { Credentials } from "./credentials.js";
import type { LocalFile } from "./local-file.js";

/** Files bigger than this are uploaded in chunks (also the chunk size; v2 needs ≥ 5 MB) */
const CHUNK_SIZE = 10 * 1024 * 1024;

const PROPFIND_BODY = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <d:prop>
    <d:getlastmodified/><d:getcontentlength/><d:getcontenttype/><d:resourcetype/><d:getetag/>
    <oc:fileid/><oc:size/><oc:permissions/><oc:favorite/><oc:owner-display-name/>
    <d:quota-used-bytes/><d:quota-available-bytes/>
  </d:prop>
</d:propfind>`;

const TRASH_PROPFIND_BODY = `<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <d:prop>
    <nc:trashbin-filename/><nc:trashbin-original-location/><nc:trashbin-deletion-time/>
    <d:getcontentlength/><d:resourcetype/><oc:size/>
  </d:prop>
</d:propfind>`;

/** A file or folder as WebDAV reports it. */
export interface NodeInfo {
  /** Path relative to the user's files root, starting with "/" */
  path: string;
  name: string;
  isDir: boolean;
  /** File size, or the total size of a folder's contents */
  size: number;
  modified: string;
  contentType?: string;
  fileId?: string;
  etag?: string;
  /** WebDAV permission letters: R share, S shared, M mounted, G read, D delete, N rename, V move, W write, C/K create */
  permissions?: string;
  isFavorite: boolean;
  owner?: string;
  quotaUsed?: number;
  quotaAvailable?: number;
}

/** An item of the trash bin. */
export interface TrashItem {
  /** Name inside the trash bin (with the ".d<timestamp>" suffix); used to restore or delete */
  trashName: string;
  originalName: string;
  originalLocation: string;
  deletedAt: Date;
  isDir: boolean;
  size: number;
}

/** A share as the OCS API returns it (only the fields used here). */
export interface Share {
  id: string;
  share_type: number;
  uid_owner: string;
  displayname_owner: string;
  permissions: number;
  stime: number;
  expiration: string | null;
  path: string;
  item_type: "file" | "folder";
  file_target: string;
  share_with?: string | null;
  share_with_displayname?: string | null;
  url?: string;
  token?: string | null;
  label?: string | null;
  note?: string;
  password?: string | null;
}

/** Thrown when there are no credentials or the server rejects them. */
export class NotLoggedInError extends Error {
  constructor(message = "Not logged in to Nextcloud — call the `login` tool first") {
    super(message);
  }
}

/** Raw PROPFIND/SEARCH response entry after XML parsing. */
interface DavResponse {
  href: string;
  propstat: { prop: Record<string, unknown>; status: string }[];
}

const xmlParser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  // Keep raw strings: file names like "007" must not turn into numbers
  parseTagValue: false,
  isArray: (tagName) => tagName === "response" || tagName === "propstat",
});

/** Escape text for an XML element body. */
function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (character) => `&#${character.charCodeAt(0)};`);
}

/** Percent-encode every segment of a slash-separated path. */
function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * Normalize a user-given path: "", "a/b", "/a/b/", or a Files app URL
 * (…/apps/files/files/123?dir=/a/b) all become "/a/b" ("/" for the root).
 * @param input - path or URL
 */
export function normalizePath(input: string): string {
  let path = input.trim();
  if (/^https?:\/\//.test(path)) {
    const url = new URL(path);
    // A file link (…/files/<fileId>?dir=…&openfile=true) carries only the folder path by name
    path = url.searchParams.get("dir") ?? "/";
  }
  const segments = path.split("/").filter((segment) => segment && segment !== ".");
  if (segments.includes("..")) throw new Error(`".." is not allowed in paths: ${input}`);
  return `/${segments.join("/")}`;
}

/** Parent folder of a normalized path. */
export function parentPath(path: string): string {
  const parent = path.slice(0, path.lastIndexOf("/"));
  return parent || "/";
}

/** Last segment of a normalized path. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Join a folder path and a name. */
export function joinPath(folder: string, name: string): string {
  return folder === "/" ? `/${name}` : `${folder}/${name}`;
}

/** Pull the human-readable <s:message> out of a Sabre error body, if any. */
function extractErrorMessage(body: string): string {
  const match = body.match(/<s:message>([\s\S]*?)<\/s:message>/);
  if (match) return match[1].trim();
  try {
    const json = JSON.parse(body);
    return json?.ocs?.meta?.message ?? body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}

export class NextcloudClient {
  private credentials: Credentials;

  constructor(credentials: Credentials) {
    this.credentials = credentials;
  }

  /** Replace credentials at runtime (after `login`). */
  setCredentials(credentials: Credentials): void {
    this.credentials = credentials;
  }

  /** Base URL of the server in use. */
  get serverUrl(): string {
    return this.credentials.serverUrl!;
  }

  /** True when an app password and a user ID are known. */
  get isLoggedIn(): boolean {
    return Boolean(this.credentials.serverUrl && this.credentials.loginName && this.credentials.appPassword && this.credentials.userId);
  }

  /** User ID used in WebDAV paths. */
  get userId(): string {
    if (!this.isLoggedIn) throw new NotLoggedInError();
    return this.credentials.userId!;
  }

  /** Absolute WebDAV URL of a path in the user's files. */
  filesUrl(path: string): string {
    return `${this.serverUrl}/remote.php/dav/files/${encodeURIComponent(this.userId)}${encodePath(path)}`;
  }

  /** Web UI link that opens a folder in the Files app. */
  webUrl(folderPath: string): string {
    return `${this.serverUrl}/apps/files/?dir=${encodeURIComponent(folderPath)}`;
  }

  /**
   * Send an authenticated request and turn HTTP errors into exceptions.
   * @param method - HTTP or WebDAV method
   * @param url - absolute URL
   * @param options - extra headers and body
   * @param resourceLabel - shown in "not found" errors
   */
  private async request(
    method: string,
    url: string,
    options: { headers?: Record<string, string>; body?: BodyInit } = {},
    resourceLabel = url
  ): Promise<Response> {
    if (!this.isLoggedIn) throw new NotLoggedInError();
    const basicToken = Buffer.from(`${this.credentials.loginName}:${this.credentials.appPassword}`).toString("base64");
    const response = await fetch(url, {
      method,
      headers: { Authorization: `Basic ${basicToken}`, "OCS-APIRequest": "true", ...options.headers },
      body: options.body,
      // Node's fetch needs this for streaming request bodies
      ...(options.body instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit);
    if (response.ok) return response;

    const body = await response.text();
    if (response.status === 401) {
      throw new NotLoggedInError("Nextcloud rejected the app password (revoked or expired) — call `login` again");
    }
    if (response.status === 404) throw new Error(`Not found: ${resourceLabel}`);
    throw new Error(`${method} ${resourceLabel} failed with HTTP ${response.status}: ${extractErrorMessage(body)}`);
  }

  /** Parse a multistatus body into entries with their successful props. */
  private parseMultistatus(xml: string): { href: string; prop: Record<string, unknown> }[] {
    const parsed = xmlParser.parse(xml);
    const responses: DavResponse[] = parsed?.multistatus?.response ?? [];
    return responses.map((entry) => {
      const okPropstat = entry.propstat.find((propstat) => String(propstat.status).includes(" 200 "));
      return { href: decodeURIComponent(entry.href), prop: (okPropstat?.prop ?? {}) as Record<string, unknown> };
    });
  }

  /** Convert a parsed WebDAV entry of the files tree into NodeInfo. */
  private toNodeInfo(href: string, prop: Record<string, unknown>): NodeInfo {
    const filesPrefix = decodeURIComponent(new URL(this.filesUrl("/")).pathname).replace(/\/$/, "");
    const path = normalizePath(href.startsWith(filesPrefix) ? href.slice(filesPrefix.length) : href);
    const resourceType = prop.resourcetype;
    const isDir = typeof resourceType === "object" && resourceType !== null && "collection" in resourceType;
    const text = (key: string): string | undefined => {
      const value = prop[key];
      return value === undefined || value === "" ? undefined : String(value);
    };
    const number = (key: string): number | undefined => {
      const value = text(key);
      return value === undefined ? undefined : Number(value);
    };
    return {
      path,
      name: path === "/" ? "/" : baseName(path),
      isDir,
      size: number("size") ?? number("getcontentlength") ?? 0,
      modified: text("getlastmodified") ?? "",
      contentType: text("getcontenttype"),
      fileId: text("fileid"),
      etag: text("getetag")?.replace(/"/g, ""),
      permissions: text("permissions"),
      isFavorite: text("favorite") === "1",
      owner: text("owner-display-name"),
      quotaUsed: number("quota-used-bytes"),
      // Negative values mean "unlimited" or "unknown"
      quotaAvailable: number("quota-available-bytes"),
    };
  }

  /**
   * Metadata of a path and, for a folder, of its direct children.
   * @param path - normalized path
   * @returns the item itself first, then children
   */
  async list(path: string): Promise<NodeInfo[]> {
    const response = await this.request(
      "PROPFIND",
      this.filesUrl(path),
      { headers: { Depth: "1", "Content-Type": "application/xml" }, body: PROPFIND_BODY },
      path
    );
    return this.parseMultistatus(await response.text()).map(({ href, prop }) => this.toNodeInfo(href, prop));
  }

  /** Metadata of one file or folder. */
  async stat(path: string): Promise<NodeInfo> {
    const response = await this.request(
      "PROPFIND",
      this.filesUrl(path),
      { headers: { Depth: "0", "Content-Type": "application/xml" }, body: PROPFIND_BODY },
      path
    );
    const [entry] = this.parseMultistatus(await response.text());
    return this.toNodeInfo(entry.href, entry.prop);
  }

  /** True if a path exists. */
  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path);
      return true;
    } catch (error) {
      if ((error as Error).message.startsWith("Not found")) return false;
      throw error;
    }
  }

  /**
   * Server-side search (WebDAV SEARCH) in a folder tree.
   * @param options.query - name substring (case-insensitive); omit to match any name
   * @param options.folder - folder to search in, recursively
   * @param options.mimeType - MIME filter, "%" is a wildcard (e.g. "image/%")
   * @param options.modifiedAfter - only items modified after this date
   * @param options.filesOnly - skip folders (applied on the server, so `limit` counts files only)
   * @param options.limit - max results
   */
  async search(options: {
    query?: string;
    folder: string;
    mimeType?: string;
    modifiedAfter?: Date;
    filesOnly?: boolean;
    limit: number;
  }): Promise<NodeInfo[]> {
    const conditions: string[] = [];
    if (options.query) {
      conditions.push(
        `<d:like><d:prop><d:displayname/></d:prop><d:literal>%${escapeXml(options.query)}%</d:literal></d:like>`
      );
    }
    if (options.mimeType) {
      conditions.push(
        `<d:like><d:prop><d:getcontenttype/></d:prop><d:literal>${escapeXml(options.mimeType)}</d:literal></d:like>`
      );
    }
    if (options.modifiedAfter) {
      conditions.push(
        `<d:gt><d:prop><d:getlastmodified/></d:prop><d:literal>${options.modifiedAfter.toISOString()}</d:literal></d:gt>`
      );
    }
    if (options.filesOnly) {
      conditions.push(
        `<d:not><d:eq><d:prop><d:getcontenttype/></d:prop><d:literal>httpd/unix-directory</d:literal></d:eq></d:not>`
      );
    }
    // SEARCH needs a condition: "not a folder or a folder" would be awkward, a match-all LIKE works
    if (conditions.length === 0) {
      conditions.push(`<d:like><d:prop><d:displayname/></d:prop><d:literal>%</d:literal></d:like>`);
    }
    const where = conditions.length === 1 ? conditions[0] : `<d:and>${conditions.join("")}</d:and>`;
    const scope = `/files/${escapeXml(this.userId)}${escapeXml(options.folder === "/" ? "" : options.folder)}`;
    const selectProps = PROPFIND_BODY.match(/<d:prop>([\s\S]*?)<\/d:prop>/)![1];
    const body = `<?xml version="1.0"?>
<d:searchrequest xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <d:basicsearch>
    <d:select><d:prop>${selectProps}</d:prop></d:select>
    <d:from><d:scope><d:href>${scope}</d:href><d:depth>infinity</d:depth></d:scope></d:from>
    <d:where>${where}</d:where>
    <d:orderby><d:order><d:prop><d:getlastmodified/></d:prop><d:descending/></d:order></d:orderby>
    <d:limit><d:nresults>${options.limit}</d:nresults></d:limit>
  </d:basicsearch>
</d:searchrequest>`;
    const response = await this.request(
      "SEARCH",
      `${this.serverUrl}/remote.php/dav/`,
      { headers: { "Content-Type": "text/xml" }, body },
      options.folder
    );
    return this.parseMultistatus(await response.text()).map(({ href, prop }) => this.toNodeInfo(href, prop));
  }

  /** Create one folder (the parent must exist). */
  async createFolder(path: string): Promise<void> {
    await this.request("MKCOL", this.filesUrl(path), {}, path);
  }

  /**
   * Create a folder and any missing parents; existing folders are fine.
   * @param path - normalized path
   */
  async ensureFolder(path: string): Promise<void> {
    if (path === "/") return;
    try {
      await this.createFolder(path);
    } catch (error) {
      const message = (error as Error).message;
      // 405: already exists
      if (message.includes("HTTP 405")) return;
      // 409: parent is missing — create it and retry
      if (message.includes("HTTP 409")) {
        await this.ensureFolder(parentPath(path));
        await this.createFolder(path);
        return;
      }
      throw error;
    }
  }

  /** Delete a file or folder (it goes to the trash bin when the trash app is on). */
  async delete(path: string): Promise<void> {
    await this.request("DELETE", this.filesUrl(path), {}, path);
  }

  /**
   * Move/rename or copy a file or folder.
   * @param method - "MOVE" or "COPY"
   * @param fromPath - source path
   * @param toPath - full destination path (including the name)
   * @param overwrite - replace an existing destination
   */
  async transfer(method: "MOVE" | "COPY", fromPath: string, toPath: string, overwrite: boolean): Promise<void> {
    await this.request(
      method,
      this.filesUrl(fromPath),
      { headers: { Destination: this.filesUrl(toPath), Overwrite: overwrite ? "T" : "F" } },
      fromPath
    );
  }

  /**
   * Upload a local file; big files go through chunked upload v2.
   * @param file - opened local file
   * @param remotePath - full destination path
   */
  async upload(file: LocalFile, remotePath: string): Promise<void> {
    if (file.size <= CHUNK_SIZE) {
      await this.request(
        "PUT",
        this.filesUrl(remotePath),
        { headers: { "Content-Type": "application/octet-stream" }, body: file.blob },
        remotePath
      );
      return;
    }

    const uploadFolder = `${this.serverUrl}/remote.php/dav/uploads/${encodeURIComponent(this.userId)}/nextcloud-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const destinationHeaders = {
      Destination: this.filesUrl(remotePath),
      "OC-Total-Length": String(file.size),
    };
    await this.request("MKCOL", uploadFolder, { headers: destinationHeaders }, remotePath);
    try {
      // Chunk names must be numbers 1…10000 in upload order
      for (let offset = 0, chunkNumber = 1; offset < file.size; offset += CHUNK_SIZE, chunkNumber++) {
        await this.request(
          "PUT",
          `${uploadFolder}/${String(chunkNumber).padStart(5, "0")}`,
          { headers: destinationHeaders, body: file.blob.slice(offset, offset + CHUNK_SIZE) },
          remotePath
        );
      }
      await this.request("MOVE", `${uploadFolder}/.file`, { headers: destinationHeaders }, remotePath);
    } catch (error) {
      // Leftover chunks would only waste space until the server's cleanup job runs
      await this.request("DELETE", uploadFolder).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Download a file to a local path (parent folders are created).
   * @param remotePath - file path on the server
   * @param localPath - destination file on this machine
   */
  async download(remotePath: string, localPath: string): Promise<void> {
    const response = await this.request("GET", this.filesUrl(remotePath), {}, remotePath);
    await mkdir(dirname(localPath), { recursive: true });
    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
      createWriteStream(localPath)
    );
  }

  /** Read a file as text (for small files only). */
  async readText(remotePath: string): Promise<string> {
    const response = await this.request("GET", this.filesUrl(remotePath), {}, remotePath);
    return response.text();
  }

  /** Mark or unmark a file/folder as favorite. */
  async setFavorite(path: string, isFavorite: boolean): Promise<void> {
    const body = `<?xml version="1.0"?>
<d:propertyupdate xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:set><d:prop><oc:favorite>${isFavorite ? 1 : 0}</oc:favorite></d:prop></d:set>
</d:propertyupdate>`;
    await this.request("PROPPATCH", this.filesUrl(path), { headers: { "Content-Type": "application/xml" }, body }, path);
  }

  // ─── Trash bin ─────────────────────────────────────────

  /** Base URL of the trash bin. */
  private trashUrl(): string {
    return `${this.serverUrl}/remote.php/dav/trashbin/${encodeURIComponent(this.userId)}`;
  }

  /** List the top-level items of the trash bin, newest first. */
  async listTrash(): Promise<TrashItem[]> {
    const response = await this.request("PROPFIND", `${this.trashUrl()}/trash`, {
      headers: { Depth: "1", "Content-Type": "application/xml" },
      body: TRASH_PROPFIND_BODY,
    });
    return this.parseMultistatus(await response.text())
      .filter(({ prop }) => prop["trashbin-filename"] !== undefined)
      .map(({ href, prop }) => {
        const resourceType = prop.resourcetype;
        return {
          trashName: href.replace(/\/$/, "").split("/").pop()!,
          originalName: String(prop["trashbin-filename"]),
          originalLocation: String(prop["trashbin-original-location"] ?? ""),
          deletedAt: new Date(Number(prop["trashbin-deletion-time"]) * 1000),
          isDir: typeof resourceType === "object" && resourceType !== null && "collection" in resourceType,
          size: Number(prop.size ?? prop.getcontentlength ?? 0),
        };
      })
      .sort((first, second) => second.deletedAt.getTime() - first.deletedAt.getTime());
  }

  /** Restore a trash item to its original location. */
  async restoreFromTrash(trashName: string): Promise<void> {
    await this.request(
      "MOVE",
      `${this.trashUrl()}/trash/${encodeURIComponent(trashName)}`,
      { headers: { Destination: `${this.trashUrl()}/restore/${encodeURIComponent(trashName)}` } },
      trashName
    );
  }

  /** Permanently delete one trash item, or empty the whole trash bin. */
  async deleteFromTrash(trashName?: string): Promise<void> {
    const url = trashName ? `${this.trashUrl()}/trash/${encodeURIComponent(trashName)}` : `${this.trashUrl()}/trash`;
    await this.request("DELETE", url, {}, trashName ?? "trash");
  }

  // ─── Shares (OCS) ──────────────────────────────────────

  /**
   * Call the files_sharing OCS API.
   * @param method - HTTP method
   * @param endpoint - path after /shares, e.g. "" or "/123"
   * @param params - query (GET/DELETE) or form body (POST/PUT) parameters
   */
  private async ocs<T>(method: string, endpoint: string, params: Record<string, string> = {}): Promise<T> {
    const isBodyMethod = method === "POST" || method === "PUT";
    const query = new URLSearchParams({ format: "json", ...(isBodyMethod ? {} : params) });
    const response = await this.request(
      method,
      `${this.serverUrl}/ocs/v2.php/apps/files_sharing/api/v1/shares${endpoint}?${query}`,
      {
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: isBodyMethod ? new URLSearchParams(params) : undefined,
      },
      params.path ?? `share${endpoint}`
    );
    const body = (await response.json()) as { ocs: { data: T } };
    return body.ocs.data;
  }

  /**
   * List shares.
   * @param options.path - only shares of this file/folder
   * @param options.sharedWithMe - shares other users made with the current user
   * @param options.subfiles - with `path` on a folder: shares of the items inside it
   */
  async listShares(options: { path?: string; sharedWithMe?: boolean; subfiles?: boolean } = {}): Promise<Share[]> {
    const params: Record<string, string> = {};
    if (options.path) params.path = options.path;
    if (options.sharedWithMe) params.shared_with_me = "true";
    if (options.subfiles) params.subfiles = "true";
    return this.ocs<Share[]>("GET", "", params);
  }

  /**
   * Create a share.
   * @param options.shareType - 0 user, 1 group, 3 public link, 4 email
   * @param options.permissions - bitmask: 1 read, 2 update, 4 create, 8 delete, 16 share
   */
  async createShare(options: {
    path: string;
    shareType: number;
    shareWith?: string;
    permissions?: number;
    password?: string;
    expireDate?: string;
    label?: string;
    note?: string;
  }): Promise<Share> {
    const params: Record<string, string> = { path: options.path, shareType: String(options.shareType) };
    if (options.shareWith) params.shareWith = options.shareWith;
    if (options.permissions !== undefined) params.permissions = String(options.permissions);
    if (options.password) params.password = options.password;
    if (options.expireDate) params.expireDate = options.expireDate;
    if (options.label) params.label = options.label;
    if (options.note) params.note = options.note;
    return this.ocs<Share>("POST", "", params);
  }

  /** Change permissions, password, expiry, label or note of a share. */
  async updateShare(shareId: string, updates: Record<string, string>): Promise<Share> {
    return this.ocs<Share>("PUT", `/${encodeURIComponent(shareId)}`, updates);
  }

  /** Delete a share. */
  async deleteShare(shareId: string): Promise<void> {
    await this.ocs("DELETE", `/${encodeURIComponent(shareId)}`);
  }
}
