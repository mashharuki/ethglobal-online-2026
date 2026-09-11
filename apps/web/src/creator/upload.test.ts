import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../api/client";
import { uploadCreatorFile } from "./upload";

const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3iwdxxm5rffg3r2xxzr5wsycy";
afterEach(() => vi.unstubAllGlobals());
describe("Creator Pinata SDK uploads", () => {
  it.each([
    new File([], "empty", { type: "application/octet-stream" }),
    new File(["plaintext"], "secret", { type: "text/plain" }),
    new File([new Uint8Array(26214401)], "huge", {
      type: "application/octet-stream",
    }),
  ])(
    "should reject invalid files before requesting capabilities",
    async (file) => {
      const auth = vi.fn();
      await expect(
        uploadCreatorFile(
          createApi("https://gateway.test"),
          auth,
          "encrypted-content",
          file,
        ),
      ).rejects.toThrow("Invalid");
      expect(auth).not.toHaveBeenCalled();
    },
  );
  it("should reject absent login", async () => {
    await expect(
      uploadCreatorFile(
        createApi("https://gateway.test"),
        async () => null,
        "preview",
        new File(["{}"], "preview.json", { type: "application/json" }),
      ),
    ).rejects.toThrow("Sign in");
  });
  it.each([cid, "../../secrets"])(
    "should upload through SDK and validate CID %s",
    async (returnedCid) => {
      const bytes = new Uint8Array([1, 2, 3]);
      const transport = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : String(input);
          if (url.startsWith("https://gateway.test")) {
            expect((input as Request).headers.get("Authorization")).toBe(
              "Bearer privy-test",
            );
            return Response.json({
              signedUrl:
                "https://uploads.pinata.cloud/v3/files/test?signed=secret",
              expiresIn: 60,
            });
          }
          const form = init?.body as FormData;
          const sent = form.get("file") as File;
          expect(new Uint8Array(await sent.arrayBuffer())).toEqual(bytes);
          expect(JSON.stringify(init?.headers)).not.toContain("privy-test");
          return Response.json({ data: { cid: returnedCid } });
        },
      );
      vi.stubGlobal("fetch", transport);
      const result = uploadCreatorFile(
        createApi("https://gateway.test", transport),
        async () => "privy-test",
        "encrypted-content",
        new File([bytes], "content.enc", { type: "application/octet-stream" }),
      );
      if (returnedCid === cid)
        await expect(result).resolves.toBe(`ipfs://${cid}`);
      else await expect(result).rejects.toThrow("IPFS upload failed");
    },
  );
});
