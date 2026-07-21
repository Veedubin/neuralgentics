# Publishing `neuralgentics-web` to PyPI

This is the **one-time setup checklist** for publishing the `neuralgentics-web`
Python package to PyPI via **trusted publishing** (OIDC — no API tokens, no
long-lived secrets stored in GitHub).

> **Package**: `neuralgentics-web` (lives at `packages/web/` in this repo)
> **PyPI project name**: `neuralgentics-web`
> **GitHub repo**: `Veedubin/neuralgentics`
> **Workflow file**: `.github/workflows/publish-pypi.yml`
> **Release tag prefix**: `web-v*.*.*` (e.g. `web-v0.15.0`)
> **GitHub environment**: `pypi`

The `web-` prefix on the tag distinguishes these releases from the
`@veedubin/neuralgentics` npm package, which is published by
`.github/workflows/release.yml` on `v*` tags.

---

## 1. Create the "pending publisher" on PyPI

This registers the GitHub workflow as authorized to publish the package
**before** the package has ever existed on PyPI. After the first successful
publish, PyPI converts the pending publisher into a real publisher
automatically.

1. Open <https://pypi.org/manage/account/publishing/> in a browser.
2. Click **"Add a new pending publisher"**.
3. Fill in **exactly** these values (they must match the workflow file
   character-for-character):

   | Field             | Value                  |
   |-------------------|------------------------|
   | PyPI Project Name | `neuralgentics-web`    |
   | Owner             | `Veedubin`             |
   | Repository        | `neuralgentics`        |
   | Workflow name     | `publish-pypi.yml`     |
   | Environment name   | `pypi`                 |

4. Click **"Add"**. PyPI will show the pending publisher in your account.

> ⚠️ The values are case-sensitive. `Veedubin` must have a capital `V`,
> `neuralgentics` must be lowercase, the workflow filename is
> `publish-pypi.yml` (with `.yml`, not `.yaml`), and the environment is
> `pypi` (lowercase). A mismatch on any field causes the publish step to
> fail with `400 Bad Request` from PyPI.

## 2. Create the `pypi` environment in the GitHub repo

The workflow's job declares `environment: pypi`, so GitHub will refuse to run
that job unless an environment with that exact name exists.

1. Go to <https://github.com/Veedubin/neuralgentics/settings/environments>.
2. Click **"New environment"**.
3. Name it **`pypi`** (lowercase, exactly).
4. Click **"Configure environment"**.
5. (Optional but recommended) Under **"Required reviewers"**, add yourself so
   a human must approve the publish before it runs. This is belt-and-suspenders
   on top of the trusted-publisher binding.

No environment secrets are needed. Trusted publishing uses OIDC, not
tokens — the `pypa/gh-action-pypi-publish@release/v1` action mints a
short-lived token from GitHub's OIDC provider at publish time.

## 3. Tag and push

The current version is in `packages/web/pyproject.toml` (e.g. `0.15.0`).
The tag must be `web-v<version>`:

```bash
cd /home/jcharles/Projects/MCP-Servers/neuralgentics
git tag web-v0.15.0
git push origin web-v0.15.0
```

(Replace `0.15.0` with the real version you're publishing. Bump the version
in `pyproject.toml` first if you're cutting a new release.)

## 4. What success looks like

1. The **Publish to PyPI** workflow starts on GitHub Actions within seconds
   of the tag push:
   <https://github.com/Veedubin/neuralgentics/actions/workflows/publish-pypi.yml>
2. The job turns green. The "Publish to PyPI" step logs something like:
   ```
   Uploading neuralgentics_web-0.15.0-py3-none-any.whl ... 100% done
   Uploading neuralgentics_web-0.15.0.tar.gz ... 100% done
   ```
3. The package appears on PyPI within ~30 seconds:
   <https://pypi.org/project/neuralgentics-web/>
4. `pip install neuralgentics-web` works from any machine.
5. A GitHub Release is also created at
   <https://github.com/Veedubin/neuralgentics/releases> under the
   `web-v0.15.0` tag, with auto-generated release notes and the built
   sdist/wheel attached.

## 5. First-release note

The pending publisher you created in step 1 is a **one-shot** binding. PyPI
promotes it to a real publisher automatically after the first successful
publish — you do not need to do anything. Subsequent releases just need a
new `web-v*` tag; the workflow re-runs and PyPI accepts it because the
publisher is now permanent.

If you ever want to change the workflow filename, the environment name, or
move the package to a different repo, you must add a new pending publisher
first (the old publisher binding will continue to authorize the old config
until you delete it from the PyPI dashboard).

## 6. ⚠️ Never retag a public release

Per the workspace `AGENTS.md` rule, once a `web-v*` tag has been pushed AND
the package has been published to PyPI, that tag is **immutable**. PyPI does
not honor tag retags — the published wheel/sdist stays bound to the original
SHA, and `git tag -d` + `git tag -a` + `git push --force` erases the
original tag object's history.

If you find a bug after a release: **bump the patch number** (e.g.
`web-v0.15.0` → `web-v0.15.1`), add the fix as a new commit, tag the new
commit, push the new tag. Never retag `web-v0.15.0` to a different commit.

The only exception is the data-leak case documented in `AGENTS.md` — and
even then you must re-publish to PyPI immediately because the original
wheel is still cached on PyPI's CDN.