import { describe, expect, it } from "vitest";

import { bytesToBase64 } from "./encoding";

describe("bytesToBase64", () => {
  it("encodes bytes to standard base64", () => {
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe("aGk=");
  });

  it("encodes an empty array", () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe("");
  });

  it("round-trips through atob", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const decoded = Uint8Array.from(atob(bytesToBase64(bytes)), (c) =>
      c.charCodeAt(0),
    );
    expect([...decoded]).toEqual([...bytes]);
  });
});
