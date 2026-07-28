/**
 * Tests for the TLS certificate generation module (tls.ts).
 *
 * Covers:
 *   - Cert generation produces a valid PEM trio (ca.crt, server.crt, server.key)
 *   - Key files have 0600 permissions
 *   - SANs include localhost + 127.0.0.1
 *   - openssl verify -CAfile ca.crt server.crt succeeds (chain verifies)
 *   - openssl x509 -text shows the correct SANs
 *   - Idempotency: re-running generateCerts is a no-op (certs not clobbered)
 *   - buildSans always includes localhost + 127.0.0.1
 *   - detectLanIp returns a valid IP or null
 *   - certsExist correctly detects existing/missing certs
 *
 * Uses real openssl in a temp directory — no mocking. These are real
 * integration tests that prove the generated chain actually verifies.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, spyOn } from "bun:test";
import { promises as fs, existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import * as childProcess from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import {
  generateCerts,
  certsExist,
  certPaths,
  certsDir,
  detectLanIp,
  buildSans,
  hasOpenSSL,
  extractSansFromCert,
  verifyCertChain,
  getFileMode,
} from "./tls.js";

// Skip the entire suite if openssl is not installed (e.g. CI without openssl).
const opensslAvailable = hasOpenSSL();

const tlsDescribe = opensslAvailable ? describe : describe.skip;

// The db-stack.test.ts file installs a global spy on childProcess.execSync
// that intercepts ALL execSync calls. Our TLS tests need real execSync for
// cert generation. We save the spy, restore the real function for our tests,
// then restore the spy afterwards so db-stack.test.ts still works.
let savedSpy: ReturnType<typeof spyOn> | null = null;

beforeAll(() => {
  const globalSpy = (globalThis as any).__execSyncSpy;
  if (globalSpy) {
    savedSpy = globalSpy;
    savedSpy!.mockRestore();
  }
});

afterAll(() => {
  if (savedSpy) {
    // Re-install the spy for other test files that depend on it.
    (globalThis as any).__execSyncSpy = spyOn(childProcess, "execSync");
    (globalThis as any).__execSyncSpy.mockImplementation(() => {
      throw new Error(
        "execSync was called without a mock implementation. " +
        "Each test must call mockReset() + mockImplementation() on the global spy.",
      );
    });
  }
});

tlsDescribe("TLS cert generation (tls.ts)", () => {
  let tmpDir: string;
  let stackPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "neuralgentics-tls-test-"));
    stackPath = path.join(tmpDir, "stack");
    await fs.mkdir(stackPath, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── PEM trio ──────────────────────────────────────────────────────────────

  describe("cert generation produces valid PEM trio", () => {
    it("generates ca.crt, server.crt, and server.key", () => {
      const result = generateCerts(stackPath);
      expect(result.success).toBe(true);

      const cp = certPaths(stackPath);
      expect(existsSync(cp.caCert)).toBe(true);
      expect(existsSync(cp.serverCert)).toBe(true);
      expect(existsSync(cp.serverKey)).toBe(true);
    });

    it("ca.crt is a valid PEM certificate", () => {
      generateCerts(stackPath);
      const cp = certPaths(stackPath);
      const pem = readFileSync(cp.caCert, "utf-8");
      expect(pem).toContain("-----BEGIN CERTIFICATE-----");
      expect(pem).toContain("-----END CERTIFICATE-----");
    });

    it("server.crt is a valid PEM certificate", () => {
      generateCerts(stackPath);
      const cp = certPaths(stackPath);
      const pem = readFileSync(cp.serverCert, "utf-8");
      expect(pem).toContain("-----BEGIN CERTIFICATE-----");
      expect(pem).toContain("-----END CERTIFICATE-----");
    });

    it("server.key is a valid PEM private key", () => {
      generateCerts(stackPath);
      const cp = certPaths(stackPath);
      const pem = readFileSync(cp.serverKey, "utf-8");
      expect(pem).toContain("-----BEGIN");
      expect(pem).toContain("PRIVATE KEY-----");
    });
  });

  // ── Key permissions ──────────────────────────────────────────────────────

  describe("key file permissions are 0600", () => {
    it("server.key has mode 0600", () => {
      generateCerts(stackPath);
      const cp = certPaths(stackPath);
      const mode = getFileMode(cp.serverKey);
      expect(mode).toBe("600");
    });

    it("ca.key has mode 0600", () => {
      generateCerts(stackPath);
      const cp = certPaths(stackPath);
      const mode = getFileMode(cp.caKey);
      expect(mode).toBe("600");
    });
  });

  // ── SANs ──────────────────────────────────────────────────────────────────

  describe("SANs include localhost + 127.0.0.1", () => {
    it("server cert SANs contain DNS:localhost", () => {
      generateCerts(stackPath);
      const cp = certPaths(stackPath);
      const sans = extractSansFromCert(cp.serverCert);
      expect(sans).not.toBeNull();
      expect(sans!).toContain("DNS:localhost");
    });

    it("server cert SANs contain IP:127.0.0.1", () => {
      generateCerts(stackPath);
      const cp = certPaths(stackPath);
      const sans = extractSansFromCert(cp.serverCert);
      expect(sans).not.toBeNull();
      // openssl -text formats SANs as "IP Address:127.0.0.1" (with a space).
      expect(sans!).toContain("127.0.0.1");
    });
  });

  // ── Chain verification (openssl verify) ───────────────────────────────────

  describe("openssl verify chain", () => {
    it("server.crt verifies against ca.crt", () => {
      generateCerts(stackPath);
      const cp = certPaths(stackPath);
      const ok = verifyCertChain(cp.caCert, cp.serverCert);
      expect(ok).toBe(true);
    });

    it("openssl x509 -text shows CN=localhost", () => {
      generateCerts(stackPath);
      const cp = certPaths(stackPath);
      const out = execSync(`openssl x509 -in "${cp.serverCert}" -text -noout`, {
        encoding: "utf-8",
        timeout: 10_000,
      });
      expect(out).toContain("CN=localhost");
    });
  });

  // ── Idempotency ──────────────────────────────────────────────────────────

  describe("idempotency", () => {
    it("re-running generateCerts is a no-op (certs not clobbered)", () => {
      // First generation.
      const result1 = generateCerts(stackPath);
      expect(result1.success).toBe(true);
      expect(result1.message).toContain("Generated TLS certificates");

      // Read the original cert content.
      const cp = certPaths(stackPath);
      const origCaCert = readFileSync(cp.caCert, "utf-8");
      const origServerCert = readFileSync(cp.serverCert, "utf-8");

      // Second generation — should be idempotent.
      const result2 = generateCerts(stackPath);
      expect(result2.success).toBe(true);
      expect(result2.message).toContain("already exist");

      // Certs should be byte-identical (not regenerated).
      const newCaCert = readFileSync(cp.caCert, "utf-8");
      const newServerCert = readFileSync(cp.serverCert, "utf-8");
      expect(newCaCert).toBe(origCaCert);
      expect(newServerCert).toBe(origServerCert);
    });

    it("certsExist returns true after generation, false before", () => {
      expect(certsExist(stackPath)).toBe(false);
      generateCerts(stackPath);
      expect(certsExist(stackPath)).toBe(true);
    });

    it("force=true regenerates certs (clobbers existing)", () => {
      generateCerts(stackPath);
      const cp = certPaths(stackPath);
      const origServerCert = readFileSync(cp.serverCert, "utf-8");

      // Wait a moment so the new cert has a different timestamp.
      execSync("sleep 1", { timeout: 5000 });

      generateCerts(stackPath, true); // force=true
      const newServerCert = readFileSync(cp.serverCert, "utf-8");
      // The certs should be different (new serial / new key).
      expect(newServerCert).not.toBe(origServerCert);
    });
  });

  // ── Cert paths ────────────────────────────────────────────────────────────

  describe("certPaths", () => {
    it("returns paths under <stackDir>/certs/", () => {
      const cp = certPaths(stackPath);
      expect(cp.certsDir).toBe(path.join(stackPath, "certs"));
      expect(cp.caCert).toBe(path.join(stackPath, "certs", "ca.crt"));
      expect(cp.serverCert).toBe(path.join(stackPath, "certs", "server.crt"));
      expect(cp.serverKey).toBe(path.join(stackPath, "certs", "server.key"));
    });
  });
});

// ── Pure functions (no openssl needed) ──────────────────────────────────────

describe("buildSans", () => {
  it("always includes DNS:localhost", () => {
    const sans = buildSans();
    expect(sans.dns).toContain("localhost");
  });

  it("always includes IP:127.0.0.1", () => {
    const sans = buildSans();
    expect(sans.ips).toContain("127.0.0.1");
  });

  it("does not duplicate entries", () => {
    const sans = buildSans();
    expect(new Set(sans.dns).size).toBe(sans.dns.length);
    expect(new Set(sans.ips).size).toBe(sans.ips.length);
  });
});

describe("detectLanIp", () => {
  it("returns null or a valid IPv4 string", () => {
    const ip = detectLanIp();
    if (ip !== null) {
      // Basic IPv4 format check.
      expect(ip).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
      // Should not be loopback.
      expect(ip).not.toBe("127.0.0.1");
    }
  });
});

describe("certsDir", () => {
  it("returns <stackDir>/certs", () => {
    expect(certsDir("/foo/bar")).toBe(path.join("/foo/bar", "certs"));
  });
});