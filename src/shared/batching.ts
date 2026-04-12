export interface TextLikeItem {
  text: string;
}

export function chunkTextLikeItems<T extends TextLikeItem>(
  items: T[],
  options?: {
    maxItems?: number;
    maxChars?: number;
  }
): T[][] {
  const maxItems = Math.max(1, options?.maxItems ?? 8);
  const maxChars = Math.max(1, options?.maxChars ?? 4_200);
  const chunks: T[][] = [];

  let currentChunk: T[] = [];
  let currentChars = 0;

  for (const item of items) {
    const itemChars = item.text.length;
    const exceedsCount = currentChunk.length >= maxItems;
    const exceedsChars =
      currentChunk.length > 0 && currentChars + itemChars > maxChars;

    if (exceedsCount || exceedsChars) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentChars = 0;
    }

    currentChunk.push(item);
    currentChars += itemChars;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

export async function mapWithConcurrency<T, TResult>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<TResult>
): Promise<TResult[]> {
  const limit = Math.max(1, concurrency);
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;

      if (currentIndex >= items.length) {
        return;
      }

      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );

  return results;
}
