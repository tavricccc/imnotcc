# Security Policy

`imnotcc` gives a browser client remote access to Claude Code running on your machine. With `bypassPermissions` enabled, that is equivalent to remote shell access as your OS user.

## Threat Model & Protections

The server applies these controls by default:

- **Loopback-only binding**: `server/index.js` listens on `127.0.0.1` only, never `0.0.0.0`.
- **Single-user password + signed cookie**: Passwords are salted and hashed with `scrypt`, compared with `timingSafeEqual`, and stored in `data/state.json`. Sessions use an HMAC-SHA256 signed `HttpOnly`, `SameSite=Strict` cookie (`Secure` when `x-forwarded-proto: https` is present).
- **Origin enforcement**: Mutating `/api/*` requests and `/ws` upgrades check `Origin` against the request host and `IMNOTCC_ORIGINS`.
- **Login rate limiting**: Failed `/api/login` attempts are throttled per minute.

## Deployment Recommendations

- **Put an external auth layer in front of any public URL.** Do not expose `imnotcc` directly to the internet with only the app password. Use Cloudflare Tunnel + Cloudflare Access, Tailscale, or an equivalent identity-aware proxy.
- **Set `IMNOTCC_ORIGINS` explicitly** to your tunnel or proxy origin when serving remotely.
- **Use a strong password** via `IMNOTCC_PASSWORD` or change the generated password in **Settings → Account** after your first login. Delete `data/password.txt` once you have logged in.

## Reporting a Vulnerability

Do not open a public GitHub issue for security vulnerabilities. Report them privately to the repository maintainers via GitHub Security Advisories (Private Vulnerability Reporting) with steps to reproduce and impact details.
