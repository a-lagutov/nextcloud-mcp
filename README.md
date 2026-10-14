# Nextcloud MCP Server

**English** · [Русский](README.ru.md)

MCP server for any Nextcloud instance. Files, search, upload/download (files and whole folders), shares and public links, favorites, trash bin. Works with any MCP client (Claude Code, Claude Desktop, Cursor, etc.).

Uses only official APIs: WebDAV (`/remote.php/dav`) and OCS (`files_sharing`). Requires **Node.js ≥ 20.12**.

## Tools (23)

| Tool | What it does |
|---|---|
| `login` | Sign in through the browser (Login Flow v2, SSO works); the app password is saved |
| `disk_info` | Used / available quota |
| `list_files` | Folder contents (sort, `limit`/`offset`) |
| `get_file_info` | Metadata: size, dates, MIME, file ID, permissions, web link |
| `search_files` | Server-side search by name (substring, case-insensitive) in a folder tree, MIME filter |
| `recent_files` | Files modified in the last N days |
| `create_folder` | Create a folder (with parents) |
| `copy` / `move` | Copy / move, rename |
| `delete` | Delete (several paths per call; to the trash bin) |
| `upload_file` | Upload a local file (chunked upload for files > 10 MB) |
| `upload_folder` | Upload a local folder recursively, in parallel |
| `download` | Download a file or a whole folder to this machine |
| `read_file` | Read a text file (first 200 KB) |
| `set_favorite` | Add / remove a favorite |
| `create_share` | Public link (password, expiry, label) or share with a user / group / email |
| `list_shares` | My shares (all, of a path; with `subfiles` — everything inside a folder at any depth) |
| `list_shared_with_me` | What others shared with me |
| `update_share` / `delete_share` | Change / remove a share |
| `list_trash` / `restore_from_trash` / `clear_trash` | Trash bin |

Paths are relative to your files root: `/`, `/Projects/logo.svg`. A Files app link works as a path too: `https://cloud.example.com/apps/files/files/123?dir=/Projects/`.

## Installation

```bash
git clone https://github.com/a-lagutov/nextcloud-mcp.git
cd nextcloud-mcp
npm install
npm run build
```

Claude Code:

```bash
claude mcp add nextcloud -s user -- node /absolute/path/to/nextcloud-mcp/dist/index.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "nextcloud": { "command": "node", "args": ["/absolute/path/to/nextcloud-mcp/dist/index.js"] }
  }
}
```

## Login

The server starts with no configuration. Ask Claude "log in to Nextcloud at https://cloud.example.com", or run `npm run login -- --server https://cloud.example.com`. The server address is remembered, so later logins need no `server_url`:

1. The server's login page opens in your default browser — sign in as usual (SSO included) and click "Grant access".
2. Nextcloud issues an **app password** for this server; it is saved to `~/.config/nextcloud-mcp/credentials.json` (mode 600) and works at once, no restart.

The `login` tool waits up to 2 minutes, then returns the login link and finishes in the background (the link is valid for 20 minutes). To switch to another server, pass a new `server_url` / `--server`.

Without a browser (Docker, SSH): create an app password in Nextcloud → Settings → Security → "Create new app password", then pass `login_name` + `app_password` to `login`, or `npm run login -- --user <LOGIN> --password <APP_PASSWORD>`.

> ⚠️ The app password gives full access to your files. Revoke it at any time: Settings → Security → Devices & sessions (it is named `nextcloud-mcp (<host>)`).

### Environment variables (optional)

They override the saved values — for example in Docker/CI.

| Variable | Purpose |
|---|---|
| `NEXTCLOUD_URL` | Server URL, e.g. `https://cloud.example.com` |
| `NEXTCLOUD_USER` | Login name |
| `NEXTCLOUD_APP_PASSWORD` | App password |
| `NEXTCLOUD_USER_ID` | Internal user ID, if it differs from the login name (otherwise call `login` once) |

## Limitations

- `search_files` searches names only, not file contents; at most 500 results per call.
- `list_files` gets the whole folder in one PROPFIND and pages locally, so huge folders take a moment.
- Deleting from a folder shared with you puts the item in the owner's trash bin, not yours.

## License

MIT
