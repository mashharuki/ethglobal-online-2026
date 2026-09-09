import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generateOpaqueValue,
  hashOpaqueValue,
  verifyPkceS256,
} from "../../src/oauth/tokenHash";

describe("generateOpaqueValue", () => {
  it("should produce a URL-safe base64 string with no padding", () => {
    const value = generateOpaqueValue();
    expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(value).not.toContain("=");
  });

  it("should never repeat across calls", () => {
    const values = new Set(Array.from({ length: 100 }, generateOpaqueValue));
    expect(values.size).toBe(100);
  });
});

describe("hashOpaqueValue", () => {
  it("should be deterministic for the same input", () => {
    const value = generateOpaqueValue();
    expect(hashOpaqueValue(value)).toBe(hashOpaqueValue(value));
  });

  it("should differ for different inputs", () => {
    expect(hashOpaqueValue("a")).not.toBe(hashOpaqueValue("b"));
  });

  it("should return a 32-byte hex string", () => {
    expect(hashOpaqueValue("x")).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("verifyPkceS256", () => {
  // Independently computed via node:crypto, not tokenHash.ts's own implementation - a bug in
  // the SHA-256 base64url derivation itself would still pass a self-referential test.
  function referenceChallenge(codeVerifier: string): string {
    return createHash("sha256")
      .update(codeVerifier)
      .digest("base64")
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  }

  it("should accept a correctly-derived S256 challenge", async () => {
    const codeVerifier = generateOpaqueValue();
    const challenge = referenceChallenge(codeVerifier);
    await expect(verifyPkceS256(codeVerifier, challenge)).resolves.toBe(true);
  });

  it("should reject a challenge for a different verifier", async () => {
    const challenge = referenceChallenge("verifier-a");
    await expect(verifyPkceS256("verifier-b", challenge)).resolves.toBe(false);
  });

  it("should reject a challenge of the wrong length", async () => {
    const codeVerifier = generateOpaqueValue();
    await expect(verifyPkceS256(codeVerifier, "short")).resolves.toBe(false);
  });

  it("should match RFC 7636 Appendix B's worked example", async () => {
    const codeVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expectedChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    await expect(verifyPkceS256(codeVerifier, expectedChallenge)).resolves.toBe(
      true,
    );
  });
});
