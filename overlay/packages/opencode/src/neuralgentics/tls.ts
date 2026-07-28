/**
 * TLS certificate generation for the self-hosted memini-ai PostgreSQL stack.
 *
 * Generates a self-signed CA + server certificate pair using `openssl` (the
 * universal cross-platform CLI tool — available on both Mac and Linux by
 * default). No Node dependencies are added; `openssl` is the only external
 * requirement.
 *
 * The generated server cert includes Subject Alternative Names (SANs) for:
 *   - DNS: localhost
 *   - IP: 127.0.0.1
 *   - The host's primary LAN IP (if detectable)
 *
 * This allows `sslmode=verify-full` connections via `localhost` (the default
 * DSN host) without certificate mismatch errors.
 *
 * Cert layout (under `<stackDir>/certs/`):
 *   ca.crt       — CA certificate (PEM, world-readable, used as sslrootcert)
 *   server.crt   — server certificate signed by the CA (PEM)
 *   server.key   — server private key (PEM, 0600 perms)
 *   ca.key       — CA private key (PEM, 0600 perms, kept for future re-signing)
 *
 * Idempotency: `generateCerts()` is a no-op if the certs dir already contains
 * a valid `ca.crt` + `server.crt` + `server.key` trio. Re-running `--db-start`
 * on an existing stack never regenerates or clobbers certs.
 */

import { execSync } from "node:child_process";
import { existsSync, writeFileSync, chmodSync, mkdirSync, readFileSync, unlinkSync, statSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/** Directory where TLS certs are stored (under the stack dir). */
export function certsDir(stackDirPath: string): string {
  return path.join(stackDirPath, "certs");
}

/** Paths for the generated cert files. */
export interface CertPaths {
  caCert: string;
  caKey: string;
  serverCert: string;
  serverKey: string;
  certsDir: string;
}

/** Get the expected cert file paths for a given stack dir. */
export function certPaths(stackDirPath: string): CertPaths {
  const dir = certsDir(stackDirPath);
  return {
    certsDir: dir,
    caCert: path.join(dir, "ca.crt"),
    caKey: path.join(dir, "ca.key"),
    serverCert: path.join(dir, "server.crt"),
    serverKey: path.join(dir, "server.key"),
  };
}

/**
 * Detect the host's primary non-loopback IPv4 address.
 * Returns null if no LAN IP is found (e.g. offline, or only loopback).
 */
export function detectLanIp(): string | null {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const addrs = interfaces[name];
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }
  return null;
}

/**
 * Build the list of Subject Alternative Names for the server cert.
 * Always includes localhost + 127.0.0.1; includes the LAN IP if detectable.
 *
 * Returns an object with DNS and IP arrays for easy testing.
 */
export function buildSans(): { dns: string[]; ips: string[] } {
  const dns = ["localhost"];
  const ips = ["127.0.0.1"];
  const lan = detectLanIp();
  if (lan && !ips.includes(lan)) {
    ips.push(lan);
  }
  return { dns: [...new Set(dns)], ips: [...new Set(ips)] };
}

/**
 * Check if `openssl` is available on the system PATH.
 */
export function hasOpenSSL(): boolean {
  try {
    execSync("openssl version", { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Result of cert generation. */
export interface CertGenResult {
  success: boolean;
  paths: CertPaths;
  /** SANs included in the server cert (for logging/testing). */
  sans: { dns: string[]; ips: string[] };
  message: string;
}

/**
 * Generate a self-signed CA + server certificate using `openssl`.
 *
 * openssl is universally available on Mac (LibreSSL or OpenSSL via Homebrew)
 * and Linux. This is the most reliable cross-platform approach — no Node
 * crypto gymnastics needed.
 *
 * @param stackDirPath The stack directory (~/.memini-ai/)
 * @param force If true, overwrite existing certs (default: false — idempotent).
 * @returns CertGenResult with paths and SAN info.
 */
export function generateCerts(stackDirPath: string, force = false): CertGenResult {
  const cp = certPaths(stackDirPath);
  const sans = buildSans();

  // Idempotency: if certs exist and force=false, skip generation.
  if (!force && certsExist(stackDirPath)) {
    return {
      success: true,
      paths: cp,
      sans,
      message: "Certificates already exist — skipped generation (idempotent).",
    };
  }

  // Ensure the certs directory exists.
  mkdirSync(cp.certsDir, { recursive: true });

  // Build SAN string for openssl.
  const sanEntries: string[] = [];
  for (const d of sans.dns) {
    sanEntries.push(`DNS:${d}`);
  }
  for (const ip of sans.ips) {
    sanEntries.push(`IP:${ip}`);
  }
  const sanString = sanEntries.join(",");

  try {
    // 1. Generate CA private key + self-signed CA cert (10-year validity).
    execSync(
      `openssl req -x509 -newkey rsa:4096 -nodes ` +
        `-keyout "${cp.caKey}" -out "${cp.caCert}" ` +
        `-days 3650 -subj "/CN=memini-ai Local CA" -sha256`,
      { stdio: "pipe", timeout: 30_000 },
    );
    chmodSync(cp.caKey, 0o600);

    // 2. Generate server private key + CSR (CN=localhost matches the DSN host).
    execSync(
      `openssl req -newkey rsa:2048 -nodes ` +
        `-keyout "${cp.serverKey}" -out "${cp.certsDir}/server.csr" ` +
        `-subj "/CN=localhost" -sha256`,
      { stdio: "pipe", timeout: 30_000 },
    );
    chmodSync(cp.serverKey, 0o600);

    // 3. Sign the server CSR with the CA, adding SANs via extfile.
    const extFile = path.join(cp.certsDir, "server.ext");
    writeFileSync(
      extFile,
      `subjectAltName=${sanString}\n` +
        `basicConstraints=CA:FALSE\n` +
        `keyUsage=digitalSignature,keyEncipherment\n` +
        `extendedKeyUsage=serverAuth\n`,
    );

    execSync(
      `openssl x509 -req -in "${cp.certsDir}/server.csr" ` +
        `-CA "${cp.caCert}" -CAkey "${cp.caKey}" -CAcreateserial ` +
        `-out "${cp.serverCert}" -days 825 -sha256 ` +
        `-extfile "${extFile}"`,
      { stdio: "pipe", timeout: 30_000 },
    );

    // Clean up CSR + ext file + serial (not needed after signing).
    for (const f of [path.join(cp.certsDir, "server.csr"), extFile, path.join(cp.certsDir, "ca.srl")]) {
      try {
        unlinkSync(f);
      } catch {
        // Non-fatal — cleanup is best-effort.
      }
    }

    return {
      success: true,
      paths: cp,
      sans,
      message: `Generated TLS certificates in ${cp.certsDir} (SANs: ${sanString}).`,
    };
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    return {
      success: false,
      paths: cp,
      sans,
      message: `Failed to generate TLS certificates: ${msg}`,
    };
  }
}

/**
 * Check whether a complete cert trio already exists.
 */
export function certsExist(stackDirPath: string): boolean {
  const cp = certPaths(stackDirPath);
  return (
    existsSync(cp.caCert) &&
    existsSync(cp.serverCert) &&
    existsSync(cp.serverKey)
  );
}

/**
 * Read the CA certificate PEM content (for inclusion in DSNs or testing).
 */
export function readCaCert(stackDirPath: string): string | null {
  const cp = certPaths(stackDirPath);
  if (!existsSync(cp.caCert)) return null;
  return readFileSync(cp.caCert, "utf-8");
}

/**
 * Parse the SANs from a PEM-encoded server certificate using openssl.
 * Returns the raw SAN extension text for verification in tests.
 */
export function extractSansFromCert(certPath: string): string | null {
  try {
    const out = execSync(
      `openssl x509 -in "${certPath}" -text -noout`,
      { stdio: "pipe", timeout: 10_000, encoding: "utf-8" },
    );
    // Extract the Subject Alternative Name line.
    const match = out.match(/Subject Alternative Name:\s*(.*)/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Verify that a server cert chains to the CA cert using openssl verify.
 * Returns true if verification succeeds.
 */
export function verifyCertChain(caCertPath: string, serverCertPath: string): boolean {
  try {
    execSync(
      `openssl verify -CAfile "${caCertPath}" "${serverCertPath}"`,
      { stdio: "pipe", timeout: 10_000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the file mode (permissions) of a file.
 * Returns the mode as an octal string like "600" or null if the file doesn't exist.
 */
export function getFileMode(filePath: string): string | null {
  try {
    const stat = statSync(filePath);
    return (stat.mode & 0o777).toString(8);
  } catch {
    return null;
  }
}