# Security Policy

StarGantt is a client-side rendering library with **zero runtime dependencies**, so its
attack surface is deliberately small — but bugs are still possible, especially around
rendering user-supplied task data (names, tooltips, custom fields) into the DOM or
canvas.

## Supported versions

Only the latest released version receives fixes. This is a hobby project with no
backporting.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

1. Preferred: use GitHub's private vulnerability reporting
   ("Security" tab → "Report a vulnerability") on this repository.
2. Fallback: email `pg.wintermaples@gmail.com` with `[StarGantt security]` in the
   subject.

Include a minimal reproduction if you can (an HTML page against the released bundle is
ideal).

## What to expect

Response and fixes are **best effort, with no SLA** — this project is maintained in free
time. Confirmed vulnerabilities will be fixed as soon as practical and credited in the
release notes unless you prefer otherwise. Please allow a reasonable disclosure window
before publishing details.
