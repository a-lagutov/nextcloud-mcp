# Security Policy

## Supported versions

Only the latest version on the `main` branch receives security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report them privately through GitHub: open the repository's **Security** tab and click
**Report a vulnerability** (private vulnerability reporting). Include:

- what is affected and how it can be exploited;
- steps to reproduce, or a proof of concept;
- the version or commit you tested.

You should get a reply within 7 days. Once a fix is released, the report can be
disclosed in a security advisory, with credit if you want it.

## Scope notes

- The server stores a Nextcloud app password in `~/.config/nextcloud-mcp/credentials.json`
  (mode 600). Problems with how it is stored, sent or logged are in scope.
- Vulnerabilities in Nextcloud itself should be reported to the Nextcloud project.
