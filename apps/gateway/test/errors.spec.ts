import { ERROR_HTTP_STATUS, ErrorCode } from "@truenft/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";
import { AppError, ERROR_MESSAGE, handleError } from "../src/errors";

function appThrowing(error: Error): Hono {
  const app = new Hono();
  app.onError(handleError);
  app.get("/", () => {
    throw error;
  });
  return app;
}

describe("AppError / handleError (T070)", () => {
  it("should answer every ErrorCode with its contract HTTP status and the openapi Error body", async () => {
    for (const code of Object.values(ErrorCode)) {
      const response = await appThrowing(new AppError(code)).request("/");
      expect(response.status, code).toBe(ERROR_HTTP_STATUS[code]);
      expect(await response.json(), code).toEqual({
        code,
        message: ERROR_MESSAGE[code],
      });
    }
  });

  it("should carry an optional detail object and a custom message", async () => {
    const response = await appThrowing(
      new AppError(ErrorCode.OWNER_EPOCH_MISMATCH, "epoch moved", {
        expected: "3",
        actual: "4",
      }),
    ).request("/");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: "OWNER_EPOCH_MISMATCH",
      message: "epoch moved",
      detail: { expected: "3", actual: "4" },
    });
  });

  it("should hide internal errors behind a generic 500 without leaking the message", async () => {
    const response = await appThrowing(
      new Error("connect to postgres://user:hunter2@db.internal failed"),
    ).request("/");
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("db.internal");
    expect(JSON.parse(text)).toEqual({
      error: "internal_error",
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it("should log only allowlisted metadata (never the message) with a correlation id matching the response", async () => {
    const logged: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      logged.push(...args);
    });
    let body: { correlationId?: string } = {};
    try {
      const key = `0x${"5a".repeat(32)}`;
      const cause = new TypeError("bearer sk-live-abcdef");
      const response = await appThrowing(
        new Error(
          `signer ${key} failed against https://user:hunter2@relay.example/api?apiKey=topsecret`,
          { cause },
        ),
      ).request("/");
      body = (await response.json()) as { correlationId?: string };
    } finally {
      spy.mockRestore();
    }
    const serialized = JSON.stringify(logged);
    for (const secret of ["5a".repeat(32), "hunter2", "topsecret", "sk-live"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain("failed against");
    expect(body.correlationId).toBeDefined();
    expect(serialized).toContain(body.correlationId);
    expect(serialized).toContain('"causeName":"TypeError"');
  });

  it("should pass Hono HTTPException responses through unchanged", async () => {
    const response = await appThrowing(
      new HTTPException(413, { message: "too large" }),
    ).request("/");
    expect(response.status).toBe(413);
    expect(await response.text()).toBe("too large");
  });
});
