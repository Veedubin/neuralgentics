# Vendored front-end assets

These files are self-hosted copies of front-end libraries that the
neuralgentics-web shell loads on every page. They replace CDN `<script>`
tags so a compromised CDN cannot inject malicious JavaScript into the
dashboard (the same risk class T-120 closed for Chart.js).

Each file has a `.SHA384` sidecar containing the base64-encoded SHA-384
digest used in the template's `integrity="sha384-..."` attribute
(Subresource Integrity). If a file is replaced or tampered, the browser
will refuse to execute it.

## How to update a vendored asset

1. Download the new version from the official source (URL below).
2. Replace the file in this directory.
3. Recompute the SHA-384 digest and write it to the `.SHA384` sidecar:
   ```bash
   python3 -c "import base64,hashlib; \
   print(base64.b64encode(hashlib.sha384(open('htmx.min.js','rb').read()).digest()).decode())" \
   > htmx.min.js.SHA384
   ```
4. Update the `integrity="sha384-..."` attribute in:
   - `src/neuralgentics/web/shell/templates/base.html`
   - `src/neuralgentics/web/shell/templates/login.html` (tailwind only)
5. Update the version + sha256 in this README.
6. Run `uv run pytest tests/test_vendor_assets_local.py` to verify the
   integrity hashes in the templates match the files on disk.

## htmx

| Field | Value |
|-------|-------|
| File | `htmx.min.js` |
| Version | 1.9.12 |
| Upstream URL | https://unpkg.com/htmx.org@1.9.12/dist/htmx.min.js |
| sha256 | `449317ade7881e949510db614991e195c3a099c4c791c24dacec55f9f4a2a452` |
| sha384 (b64) | `ujb1lZYygJmzgSwoxRggbCHcjc0rB2XoQrxeTUQyRjrOnlCoYta87iKBWq3EsdM2` |

## tailwind (Play CDN)

The `cdn.tailwindcss.com` endpoint serves the **Tailwind Play CDN** — a
single JavaScript runtime that scans the DOM for `class="..."` and
compiles the matching Tailwind utilities on the fly. It is *not* a
static CSS file; vendoring the JS runtime preserves the same
on-the-fly compilation behavior while removing the CDN trust
requirement.

| Field | Value |
|-------|-------|
| File | `tailwind.min.js` |
| Version | 3.4.1 (Play CDN build) |
| Upstream URL | https://cdn.tailwindcss.com/3.4.1 |
| sha256 | `f6f323857109867300e1e66ed9190fe206d43c8ceae3eccbf7e28820e1c98f80` |
| sha384 (b64) | `SOMLQz+nKv/ORIYXo3J3NrWJ33oBgGvkHlV9t8i70QVLq8ZtST9Np1gDsVUkk4xN` |

> **Note:** the Tailwind Play CDN is intended for development / prototyping.
> For production, the recommended path is to compile a static CSS bundle
> with only the utilities the shell actually uses (via the `tailwindcss`
> CLI). That is out of scope for T-INSTALL-006, which only closes the
> CDN-without-SRI gap; tracking in a follow-up card.