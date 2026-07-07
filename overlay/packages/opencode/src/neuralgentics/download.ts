/**
 * GitHub release download, SHA256 verification, and tarball extraction —
 * TypeScript port of `neuralgentics-cli/src/neuralgentics/download.py`.
 *
 * Uses Node 20+ built-ins only:
 *   - Native `fetch()` for HTTP (no `httpx`/`axios`).
 *   - `crypto.createHash('sha256')` for verification.
 *   - `child_process.execSync('tar -xzf ...')` for extraction.
 *
 * Public API:
 *   - `resolveVersion` — turn `"latest"` or `"X.Y.Z"` into a concrete semver
 *     string, calling the GitHub API for `"latest"`. Cached for 1 hour in
 *     `~/.cache/neuralgentics/version_cache.json`.
 *   - `downloadTarball` — fetch `neuralgentics-{version}.tar.gz` and
 *     `checksums.txt` from a GitHub release into a per-pid temp dir.
 *   - `verifySha256` — parse `checksums.txt` and compare the tarball's
 *     actual SHA256 against it.
 *   - `extractTarball` — extract the tarball to `dest` with
 *     `--strip-components=1` semantics via `tar -xzf`.
 */

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/** Base URL for the GitHub REST API. */
const GITHUB_API = "https://api.github.com";

/** Base URL for GitHub release asset downloads (not rate-limited). */
const GITHUB_DOWNLOAD = "https://github.com";

/** Cache file for `latest` version resolution (1-hour TTL). */
const CACHE_DIR = path.join(os.homedir(), ".cache", "neuralgentics");
const CACHE_FILE = path.join(CACHE_DIR, "version_cache.json");

/** Cache TTL in seconds (1 hour). */
const CACHE_TTL = 3600;

/** Read chunk size for SHA256 computation (64 KiB). */
const CHUNK_SIZE = 64 * 1024;

/** Regex for a valid `X.Y.Z` semver (no pre-release suffix). */
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/** The known required file inside the extracted tarball layout. */
const REQUIRED_EXTRACTED_FILE = path.join(".opencode", "agents", "coder.md");

/** Base class for all neuralgentics CLI errors (mirrors `errors.py`). */
export class NeuralgenticsError extends Error {
  readonly exitCode: number = 1;
  readonly remediation: string = "See the documentation for troubleshooting.";
  constructor(message: string, remediation?: string) {
    super(message);
    this.name = "NeuralgenticsError";
    if (remediation !== undefined) {
      (this as { remediation: string }).remediation = remediation;
    }
  }
}

/** An HTTP request failed (connect error, bad status, etc.). */
export class NetworkError extends NeuralgenticsError {
  readonly exitCode = 6;
  readonly remediation =
    "Check your network connection and verify the version exists on the GitHub releases page.";
  constructor(message: string, remediation?: string) {
    super(message, remediation);
    this.name = "NetworkError";
  }
}

/** Downloaded artifact's SHA256 did not match the published checksum. */
export class Sha256Mismatch extends NeuralgenticsError {
  readonly exitCode = 7;
  readonly remediation =
    "Re-run. If the problem persists, report it on GitHub issues — the download may be tampered.";
  constructor(message: string, remediation?: string) {
    super(message, remediation);
    this.name = "Sha256Mismatch";
  }
}

/** The downloaded tarball could not be extracted. */
export class TarballCorrupt extends NeuralgenticsError {
  readonly exitCode = 8;
  readonly remediation = "Check disk space and re-download. The archive may be corrupt.";
  constructor(message: string, remediation?: string) {
    super(message, remediation);
    this.name = "TarballCorrupt";
  }
}

/** A file expected after extraction was missing. */
export class ExtractionFailed extends NeuralgenticsError {
  readonly exitCode = 9;
  readonly remediation = "Check the release assets on GitHub — the archive may be incomplete.";
  constructor(message: string, remediation?: string) {
    super(message, remediation);
    this.name = "ExtractionFailed";
  }
}

/** The requested plugin version does not exist on GitHub. */
export class VersionNotFound extends NeuralgenticsError {
  readonly exitCode = 14;
  readonly remediation =
    "Check available versions at the GitHub releases page. Use 'latest' for the most recent release.";
  constructor(message: string, remediation?: string) {
    super(message, remediation);
    this.name = "VersionNotFound";
  }
}

interface VersionCache {
  [repo: string]: { ts: number; version: string };
}

/**
 * Resolve `version` to a concrete `X.Y.Z` string.
 *
 * - If `version === "latest"`, query the GitHub API
 *   `GET /repos/{repo}/releases/latest` and return `tag_name` with the
 *   leading `v` stripped. Cached for 1 hour in
 *   `~/.cache/neuralgentics/version_cache.json` (keyed by `repo`).
 * - Otherwise, validate `version` matches `X.Y.Z` and return it as-is.
 */
export async function resolveVersion(
  version: string,
  repo: string,
  githubToken?: string,
): Promise<string> {
  if (version === "latest") {
    const cached = await readCachedLatest(repo);
    if (cached !== null) return cached;
    const tag = await fetchLatestTag(repo, githubToken);
    const resolved = tag.startsWith("v") ? tag.slice(1) : tag;
    if (!SEMVER_RE.test(resolved)) {
      throw new VersionNotFound(
        `GitHub returned a non-semver tag name ${JSON.stringify(tag)} for ${repo}.`,
      );
    }
    await writeCachedLatest(repo, resolved);
    return resolved;
  }
  if (SEMVER_RE.test(version)) return version;
  throw new VersionNotFound(`Version ${JSON.stringify(version)} is not a valid X.Y.Z semver.`);
}

async function readCachedLatest(repo: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(CACHE_FILE, "utf-8");
    const data = JSON.parse(raw) as VersionCache;
    const entry = data[repo];
    if (!entry || typeof entry.ts !== "number" || typeof entry.version !== "string") {
      return null;
    }
    if (Date.now() / 1000 - entry.ts > CACHE_TTL) return null;
    return entry.version;
  } catch {
    return null;
  }
}

async function writeCachedLatest(repo: string, version: string): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    let data: VersionCache = {};
    try {
      const raw = await fs.readFile(CACHE_FILE, "utf-8");
      data = JSON.parse(raw) as VersionCache;
    } catch {
      data = {};
    }
    data[repo] = { ts: Date.now() / 1000, version };
    await fs.writeFile(CACHE_FILE, JSON.stringify(data), "utf-8");
  } catch {
    // Best-effort cache; ignore write failures.
  }
}

function resolveToken(githubToken?: string): string | undefined {
  return githubToken ?? process.env.GITHUB_TOKEN;
}

async function fetchLatestTag(repo: string, githubToken?: string): Promise<string> {
  const url = `${GITHUB_API}/repos/${repo}/releases/latest`;
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  const token = resolveToken(githubToken);
  if (token) headers["Authorization"] = `Bearer ${token}`;
  let resp: Response;
  try {
    resp = await fetch(url, { headers, redirect: "follow" });
  } catch (exc) {
    throw new NetworkError(
      `Failed to reach GitHub API at ${url}: ${exc instanceof Error ? exc.message : String(exc)}`,
      "Check your network connection and that the repository exists.",
    );
  }
  if (resp.status === 404) {
    throw new VersionNotFound(`No releases found for ${repo}.`);
  }
  if (!resp.ok) {
    throw new NetworkError(`GitHub API returned ${resp.status} ${resp.statusText} for ${url}.`);
  }
  let body: unknown;
  try {
    body = await resp.json();
  } catch (exc) {
    throw new NetworkError(
      `GitHub API returned invalid JSON for ${url}: ${exc instanceof Error ? exc.message : String(exc)}.`,
    );
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new VersionNotFound(`GitHub API response for ${repo} had no 'tag_name' field.`);
  }
  const tag = (body as { tag_name?: unknown }).tag_name;
  if (typeof tag !== "string" || tag.length === 0) {
    throw new VersionNotFound(`GitHub API response for ${repo} had no 'tag_name' field.`);
  }
  return tag;
}

/** Result of `downloadTarball`: the local paths to the tarball + checksums. */
export interface DownloadedTarball {
  tarballPath: string;
  checksumsPath: string;
}

/**
 * Download `neuralgentics-{version}.tar.gz` and `checksums.txt`.
 *
 * Returns the local paths. Files are written to a per-pid, per-version temp
 * directory under `os.tmpdir()`. On any exception the temp directory is
 * removed.
 */
export async function downloadTarball(
  version: string,
  repo: string,
  githubToken?: string,
): Promise<DownloadedTarball> {
  if (!SEMVER_RE.test(version)) {
    throw new VersionNotFound(`Version ${JSON.stringify(version)} is not a valid X.Y.Z semver.`);
  }

  const tmpDir = path.join(os.tmpdir(), `neuralgentics-${process.pid}-${version}`);
  await fs.mkdir(tmpDir, { recursive: true });
  const tarballPath = path.join(tmpDir, `neuralgentics-${version}.tar.gz`);
  const checksumsPath = path.join(tmpDir, "checksums.txt");

  const base = `${GITHUB_DOWNLOAD}/${repo}/releases/download/v${version}`;
  const tarballUrl = `${base}/neuralgentics-${version}.tar.gz`;
  const checksumsUrl = `${base}/checksums.txt`;
  const headers: Record<string, string> = {};
  const token = resolveToken(githubToken);
  if (token) headers["Authorization"] = `Bearer ${token}`;

  try {
    await streamDownload(tarballUrl, tarballPath, headers);
    await streamDownload(checksumsUrl, checksumsPath, headers);
  } catch (exc) {
    // Cleanup the temp dir on any failure so we don't leave partial files.
    try {
      const entries = await fs.readdir(tmpDir);
      await Promise.all(entries.map((e) => fs.unlink(path.join(tmpDir, e)).catch(() => {})));
      await fs.rmdir(tmpDir).catch(() => {});
    } catch {
      // Best-effort cleanup.
    }
    throw exc;
  }
  return { tarballPath, checksumsPath };
}

async function streamDownload(
  url: string,
  dest: string,
  headers: Record<string, string>,
): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(url, { headers, redirect: "follow" });
  } catch (exc) {
    throw new NetworkError(
      `Failed to download ${url}: ${exc instanceof Error ? exc.message : String(exc)}`,
      "Check your network connection and retry.",
    );
  }
  if (!resp.ok) {
    throw new NetworkError(
      `Failed to download ${url}: ${resp.status} ${resp.statusText}.`,
      "Check your network connection and that the version exists on the GitHub releases page.",
    );
  }
  const body = resp.body;
  if (body === null) {
    throw new NetworkError(`Failed to download ${url}: empty response body.`);
  }
  const fileHandle = await fs.open(dest, "w");
  try {
    const reader = body.getReader();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) await fileHandle.write(value);
    }
  } finally {
    await fileHandle.close();
  }
}

/**
 * Verify `tarballPath` against the entry in `checksumsPath`.
 *
 * `checksums.txt` lines have the form `<sha>  <filename>` (two spaces, GNU
 * coreutils format). Raises `Sha256Mismatch` if the file is missing from
 * checksums or the computed hash doesn't match.
 */
export async function verifySha256(tarballPath: string, checksumsPath: string): Promise<void> {
  const expected = await lookupChecksum(checksumsPath, path.basename(tarballPath));
  const actual = await sha256OfFile(tarballPath);
  if (actual !== expected) {
    throw new Sha256Mismatch(
      `SHA256 verification failed for ${path.basename(tarballPath)}. Expected: ${expected}, got: ${actual}.`,
    );
  }
}

async function lookupChecksum(checksumsPath: string, filename: string): Promise<string> {
  const text = await fs.readFile(checksumsPath, "utf-8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts.length !== 2) continue;
    const [sha, rawName] = parts;
    // The checksum file may prefix the name with `*` (binary mode) or `./`.
    const name = rawName.replace(/^\*/, "").replace(/^\.\//, "");
    if (name === filename && /^[0-9a-f]{64}$/.test(sha)) {
      return sha;
    }
  }
  throw new Sha256Mismatch(`${filename} not found in ${path.basename(checksumsPath)}.`);
}

async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(CHUNK_SIZE);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_SIZE, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

/**
 * Extract `tarballPath` into `dest` with `--strip-components=1` semantics.
 *
 * The release tarball has a single top-level directory
 * (`neuralgentics-{version}/`); this function flattens that one level so
 * files land directly under `dest` (e.g. `dest/.opencode/agents/coder.md`).
 *
 * Uses `tar -xzf` via `child_process.execSync` (available on all Linux/Mac).
 * After extraction, verifies that `dest/.opencode/agents/coder.md` exists —
 * a known required file from the archive layout. Raises `ExtractionFailed`
 * if missing, `TarballCorrupt` if the archive can't be opened.
 */
export async function extractTarball(tarballPath: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  try {
    execSync(`tar -xzf "${tarballPath}" -C "${dest}" --strip-components=1`, {
      stdio: "pipe",
      timeout: 60_000,
    });
  } catch (exc) {
    throw new TarballCorrupt(
      `Failed to extract tarball: ${exc instanceof Error ? exc.message : String(exc)}`,
    );
  }
  const required = path.join(dest, REQUIRED_EXTRACTED_FILE);
  try {
    await fs.access(required);
  } catch {
    throw new ExtractionFailed(`${REQUIRED_EXTRACTED_FILE} not found after extraction.`);
  }
}