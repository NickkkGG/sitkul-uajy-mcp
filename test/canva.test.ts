import { describe, expect, it } from "vitest";
import { CanvaClient } from "../src/canva.js";

describe("CanvaClient", () => {
  it("blocks a non-Canva URL before making an external request", async () => {
    const client = new CanvaClient() as unknown as { designIdFromUrl(url: string): Promise<string> };
    await expect(client.designIdFromUrl("https://example.com/design/not-canva")).rejects.toThrow(
      "Only Canva URLs returned by list_materials may be exported.",
    );
  });
});
