# Security Policy

## Report A Vulnerability

Use [GitHub's private reporting form](https://github.com/ririnto/codex-app-server/security/advisories/new) for suspected vulnerabilities.
Avoid public issues for undisclosed vulnerabilities.
Include the affected release, host and CLI versions, reproduction steps, expected behavior, and potential impact.
Remove credentials, personal paths, socket addresses, private thread identities, and message contents from evidence.
The maintainer assesses reports and coordinates fixes and disclosure through the private advisory.

## Supported Releases

Security fixes target the current release on the named `main` branch.
Update the plugin before testing a report against the supported release.

## Runtime Boundary

This plugin can inspect and drive the authenticated local Codex app-server through its Unix control socket.
Treat the socket and executable selection as access to the host's existing privileges.
Use host trust controls and authorize mutations explicitly.
Keep reset-credit consumption and native thread cleanup refused by the shared method policy.
Server-initiated approval requests remain refused by the connection layer.
Use disposable socket fixtures for security regression tests and avoid mutations against a live daemon.
