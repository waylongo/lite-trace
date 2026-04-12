import { chunkTextLikeItems, mapWithConcurrency } from "./batching";

describe("chunkTextLikeItems", () => {
  it("splits items by max item count", () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      text: `item-${index}`
    }));

    const chunks = chunkTextLikeItems(items, {
      maxItems: 4,
      maxChars: 999
    });

    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => chunk.length)).toEqual([4, 4, 2]);
  });

  it("splits items by max char count", () => {
    const items = [
      { text: "a".repeat(2000) },
      { text: "b".repeat(2100) },
      { text: "c".repeat(500) }
    ];

    const chunks = chunkTextLikeItems(items, {
      maxItems: 8,
      maxChars: 4000
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(1);
    expect(chunks[1]).toHaveLength(2);
  });

  it("keeps an oversized single item in its own chunk", () => {
    const items = [
      { text: "a".repeat(5000) },
      { text: "b".repeat(100) }
    ];

    const chunks = chunkTextLikeItems(items, {
      maxItems: 8,
      maxChars: 4000
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(1);
    expect(chunks[1]).toHaveLength(1);
  });

  it("maps items with preserved order under concurrency", async () => {
    const results = await mapWithConcurrency(
      [3, 1, 2],
      2,
      async (value) => {
        await Promise.resolve();
        return value * 2;
      }
    );

    expect(results).toEqual([6, 2, 4]);
  });
});
