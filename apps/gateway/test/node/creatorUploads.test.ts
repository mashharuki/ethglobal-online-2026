import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { handleError } from "../../src/errors";
import { registerCreatorUploadRoutes } from "../../src/routes/creatorUploads";
import type { AppEnv } from "../../src/routes/schemas";

const valid = {
  purpose: "encrypted-content",
  size: 128,
  mimeType: "application/octet-stream",
};
const signedUrl =
  "https://uploads.pinata.cloud/v3/files/test?signature=private";
afterEach(() => vi.unstubAllGlobals());
async function setup(configured = true, upstreamStatus = 200) {
  const token = "valid-privy-token";
  const boundary = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://uploads.pinata.cloud/v3/files/sign");
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer test-pinata-secret",
      );
      return Response.json(
        { data: signedUrl, error: "private upstream details" },
        { status: upstreamStatus },
      );
    },
  );
  vi.stubGlobal("fetch", boundary);
  const app = new Hono<AppEnv>();
  app.onError(handleError);
  const verifyPrincipal = vi.fn(async (_env: unknown, candidate: string) => {
    if (candidate !== token) throw new Error("invalid token");
    return { principalId: "did:privy:creator" };
  });
  registerCreatorUploadRoutes(app, verifyPrincipal);
  const env = {
    PRIVY_APP_ID: "creator-tests",
    PRIVY_APP_SECRET: "test-privy-secret",
    ...(configured ? { PINATA_JWT: "test-pinata-secret" } : {}),
  } as Env;
  const request = (
    body: unknown = valid,
    auth: string | null = token,
    ip = "1",
  ) =>
    app.request(
      "/creator/uploads",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-connecting-ip": ip,
          ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
      env,
    );
  return { request, boundary };
}
describe("creator upload capabilities", () => {
  it("should reject missing and forged authentication without contacting Pinata", async () => {
    const { request, boundary } = await setup();
    expect((await request(valid, null)).status).toBe(401);
    expect((await request(valid, "forged")).status).toBe(401);
    expect(
      boundary.mock.calls.filter(([url]) => String(url).includes("files/sign")),
    ).toHaveLength(0);
  });
  it.each([
    { ...valid, size: 0 },
    { ...valid, size: 26214401 },
    { ...valid, mimeType: "text/plain" },
    { ...valid, purpose: "shares" },
    { ...valid, name: "attacker" },
    "{bad",
  ])("should reject invalid request %j", async (body) => {
    const { request } = await setup();
    expect((await request(body)).status).toBe(400);
  });
  it("should bound the body before parsing", async () => {
    const { request } = await setup();
    expect((await request("x".repeat(2049))).status).toBe(413);
  });
  it("should sign narrowly constrained uploads and prevent caching", async () => {
    const { request, boundary } = await setup();
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ signedUrl, expiresIn: 60 });
    const call = boundary.mock.calls.find(([url]) =>
      String(url).includes("files/sign"),
    );
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      expires: 60,
      max_file_size: 128,
      allow_mime_types: ["application/octet-stream"],
    });
  });
  it("should fail clearly when unconfigured and sanitize upstream failures", async () => {
    expect((await (await setup(false)).request()).status).toBe(503);
    const response = await (await setup(true, 403)).request();
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("private");
  });
  it("should rate-limit verified principals across source IP changes", async () => {
    const { request } = await setup(false);
    for (let i = 0; i < 12; i++)
      expect((await request(valid, undefined, String(i))).status).toBe(503);
    expect((await request(valid, undefined, "new")).status).toBe(429);
  });
  it("should rate-limit unauthenticated source IPs", async () => {
    const { request } = await setup();
    for (let i = 0; i < 30; i++)
      expect((await request(valid, null)).status).toBe(401);
    expect((await request(valid, null)).status).toBe(429);
  });
});
