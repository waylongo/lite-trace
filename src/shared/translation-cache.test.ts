import { mergeSettings } from "./settings";
import {
  buildTranslationCacheKey,
  getCachedTranslations,
  pruneTranslationCache,
  setCachedTranslations,
  TRANSLATION_CACHE_MAX_ENTRIES,
  TRANSLATION_CACHE_PREFIX,
  TRANSLATION_CACHE_TTL_MS
} from "./translation-cache";

const settings = mergeSettings({
  activeProvider: "openai",
  openai: {
    baseUrl: "https://api.example.com/v1",
    model: "demo-model",
    apiKey: "openai-key"
  }
});

describe("translation cache", () => {
  let storageStore: Record<string, unknown>;

  beforeEach(() => {
    storageStore = {};

    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (keys?: string[] | string | null) => {
            if (keys == null) {
              return { ...storageStore };
            }

            if (Array.isArray(keys)) {
              return Object.fromEntries(
                keys
                  .filter((key) => key in storageStore)
                  .map((key) => [key, storageStore[key]])
              );
            }

            if (typeof keys === "string") {
              return keys in storageStore ? { [keys]: storageStore[keys] } : {};
            }

            return {};
          }),
          set: vi.fn(async (items: Record<string, unknown>) => {
            storageStore = {
              ...storageStore,
              ...items
            };
          }),
          remove: vi.fn(async (keys: string[] | string) => {
            const entries = Array.isArray(keys) ? keys : [keys];

            for (const key of entries) {
              delete storageStore[key];
            }
          })
        }
      }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds stable keys and separates provider identities", async () => {
    const firstKey = await buildTranslationCacheKey(settings, "Hello world");
    const secondKey = await buildTranslationCacheKey(settings, "Hello world");
    const differentModelKey = await buildTranslationCacheKey(
      mergeSettings({
        activeProvider: "openai",
        openai: {
          baseUrl: "https://api.example.com/v1",
          model: "another-model",
          apiKey: "openai-key"
        }
      }),
      "Hello world"
    );

    expect(firstKey).toBe(secondKey);
    expect(firstKey.startsWith(TRANSLATION_CACHE_PREFIX)).toBe(true);
    expect(differentModelKey).not.toBe(firstKey);
  });

  it("stores and reads cached translations", async () => {
    const now = 1_000_000;

    await setCachedTranslations(
      settings,
      [{ text: "Hello world", translation: "你好，世界" }],
      now
    );

    await expect(
      getCachedTranslations(settings, ["Hello world"], now + 5_000)
    ).resolves.toEqual({
      translations: ["你好，世界"],
      hitCount: 1
    });
  });

  it("ignores expired cache entries", async () => {
    const key = await buildTranslationCacheKey(settings, "Hello world");
    storageStore[key] = {
      translation: "旧译文",
      createdAt: 100,
      lastUsedAt: 100
    };

    await expect(
      getCachedTranslations(
        settings,
        ["Hello world"],
        100 + TRANSLATION_CACHE_TTL_MS + 1
      )
    ).resolves.toEqual({
      translations: [null],
      hitCount: 0
    });
  });

  it("prunes expired and overflow cache entries", async () => {
    const now = 10_000_000;

    for (let index = 0; index < TRANSLATION_CACHE_MAX_ENTRIES + 3; index += 1) {
      storageStore[`${TRANSLATION_CACHE_PREFIX}${index}`] = {
        translation: `译文-${index}`,
        createdAt: now - 1_000,
        lastUsedAt: now - index
      };
    }

    storageStore[`${TRANSLATION_CACHE_PREFIX}expired`] = {
      translation: "过期译文",
      createdAt: now - TRANSLATION_CACHE_TTL_MS - 5_000,
      lastUsedAt: now - TRANSLATION_CACHE_TTL_MS - 5_000
    };

    await pruneTranslationCache(now);

    const keys = Object.keys(storageStore).filter((key) =>
      key.startsWith(TRANSLATION_CACHE_PREFIX)
    );

    expect(keys).toHaveLength(TRANSLATION_CACHE_MAX_ENTRIES);
    expect(keys).not.toContain(`${TRANSLATION_CACHE_PREFIX}expired`);
  });
});
