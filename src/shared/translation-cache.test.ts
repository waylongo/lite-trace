import { mergeSettings } from "./settings";

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
  let buildTranslationCacheKey: typeof import("./translation-cache").buildTranslationCacheKey;
  let getCachedTranslations: typeof import("./translation-cache").getCachedTranslations;
  let pruneTranslationCache: typeof import("./translation-cache").pruneTranslationCache;
  let setCachedTranslations: typeof import("./translation-cache").setCachedTranslations;
  let TRANSLATION_CACHE_INDEX_KEY: typeof import("./translation-cache").TRANSLATION_CACHE_INDEX_KEY;
  let TRANSLATION_CACHE_MAX_ENTRIES: typeof import("./translation-cache").TRANSLATION_CACHE_MAX_ENTRIES;
  let TRANSLATION_CACHE_PREFIX: typeof import("./translation-cache").TRANSLATION_CACHE_PREFIX;
  let TRANSLATION_CACHE_TTL_MS: typeof import("./translation-cache").TRANSLATION_CACHE_TTL_MS;

  beforeEach(async () => {
    vi.resetModules();
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

    const cacheModule = await import("./translation-cache");
    buildTranslationCacheKey = cacheModule.buildTranslationCacheKey;
    getCachedTranslations = cacheModule.getCachedTranslations;
    pruneTranslationCache = cacheModule.pruneTranslationCache;
    setCachedTranslations = cacheModule.setCachedTranslations;
    TRANSLATION_CACHE_INDEX_KEY = cacheModule.TRANSLATION_CACHE_INDEX_KEY;
    TRANSLATION_CACHE_MAX_ENTRIES = cacheModule.TRANSLATION_CACHE_MAX_ENTRIES;
    TRANSLATION_CACHE_PREFIX = cacheModule.TRANSLATION_CACHE_PREFIX;
    TRANSLATION_CACHE_TTL_MS = cacheModule.TRANSLATION_CACHE_TTL_MS;
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

  it("stores cached translations and creates the cache index", async () => {
    const now = 1_000_000;

    await setCachedTranslations(
      settings,
      [{ text: "Hello world", translation: "你好，世界" }],
      now
    );

    const key = await buildTranslationCacheKey(settings, "Hello world");
    expect(storageStore[key]).toMatchObject({
      translation: "你好，世界",
      createdAt: now,
      lastUsedAt: now
    });
    expect(storageStore[TRANSLATION_CACHE_INDEX_KEY]).toMatchObject({
      version: 1,
      entries: {
        [key]: {
          createdAt: now,
          lastUsedAt: now
        }
      }
    });
  });

  it("touches both cache entries and index timestamps when reads age out", async () => {
    const now = 2_000_000;
    const key = await buildTranslationCacheKey(settings, "Hello world");

    storageStore[key] = {
      translation: "你好，世界",
      createdAt: now,
      lastUsedAt: now
    };
    storageStore[TRANSLATION_CACHE_INDEX_KEY] = {
      version: 1,
      entries: {
        [key]: {
          createdAt: now,
          lastUsedAt: now
        }
      }
    };

    await expect(
      getCachedTranslations(settings, ["Hello world"], now + 60 * 60 * 1000 + 1)
    ).resolves.toEqual({
      translations: ["你好，世界"],
      hitCount: 1
    });

    expect(storageStore[key]).toMatchObject({
      lastUsedAt: now + 60 * 60 * 1000 + 1
    });
    expect(storageStore[TRANSLATION_CACHE_INDEX_KEY]).toMatchObject({
      entries: {
        [key]: {
          createdAt: now,
          lastUsedAt: now + 60 * 60 * 1000 + 1
        }
      }
    });
  });

  it("ignores expired cache entries and clears stale index records", async () => {
    const key = await buildTranslationCacheKey(settings, "Hello world");
    const now = 3_000_000;

    storageStore[key] = {
      translation: "旧译文",
      createdAt: now - TRANSLATION_CACHE_TTL_MS - 1,
      lastUsedAt: now - TRANSLATION_CACHE_TTL_MS - 1
    };
    storageStore[TRANSLATION_CACHE_INDEX_KEY] = {
      version: 1,
      entries: {
        [key]: {
          createdAt: now - TRANSLATION_CACHE_TTL_MS - 1,
          lastUsedAt: now - TRANSLATION_CACHE_TTL_MS - 1
        }
      }
    };

    await expect(getCachedTranslations(settings, ["Hello world"], now)).resolves.toEqual({
      translations: [null],
      hitCount: 0
    });

    expect(storageStore[key]).toBeUndefined();
    expect(storageStore[TRANSLATION_CACHE_INDEX_KEY]).toMatchObject({
      version: 1,
      entries: {}
    });
  });

  it("prunes with an existing index without rebuilding from all storage", async () => {
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
    storageStore[TRANSLATION_CACHE_INDEX_KEY] = {
      version: 1,
      entries: Object.fromEntries(
        Object.entries(storageStore)
          .filter(([key]) => key.startsWith(TRANSLATION_CACHE_PREFIX))
          .map(([key, value]) => [
            key,
            {
              createdAt: (value as { createdAt: number }).createdAt,
              lastUsedAt: (value as { lastUsedAt: number }).lastUsedAt
            }
          ])
      )
    };

    const getMock = chrome.storage.local.get as ReturnType<typeof vi.fn>;
    getMock.mockClear();

    await pruneTranslationCache(now);

    expect(getMock).not.toHaveBeenCalledWith(null);

    const keys = Object.keys(storageStore).filter((key) =>
      key.startsWith(TRANSLATION_CACHE_PREFIX)
    );

    expect(keys).toHaveLength(TRANSLATION_CACHE_MAX_ENTRIES);
    expect(keys).not.toContain(`${TRANSLATION_CACHE_PREFIX}expired`);
    expect(storageStore[TRANSLATION_CACHE_INDEX_KEY]).toMatchObject({
      version: 1
    });
  });

  it("rebuilds the cache index once when missing and keeps unrelated storage intact", async () => {
    const now = 20_000_000;
    const staleKey = `${TRANSLATION_CACHE_PREFIX}stale-index-only`;

    for (let index = 0; index < TRANSLATION_CACHE_MAX_ENTRIES + 2; index += 1) {
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
    storageStore["litetrace.settings"] = { foo: "bar" };
    storageStore[TRANSLATION_CACHE_INDEX_KEY] = {
      version: 0,
      entries: {
        [staleKey]: {
          createdAt: now - 100,
          lastUsedAt: now - 100
        }
      }
    };

    await pruneTranslationCache(now);

    expect(storageStore["litetrace.settings"]).toEqual({ foo: "bar" });
    expect(storageStore[`${TRANSLATION_CACHE_PREFIX}expired`]).toBeUndefined();
    expect(storageStore[TRANSLATION_CACHE_INDEX_KEY]).toMatchObject({
      version: 1
    });

    const keys = Object.keys(storageStore).filter((key) =>
      key.startsWith(TRANSLATION_CACHE_PREFIX)
    );
    expect(keys).toHaveLength(TRANSLATION_CACHE_MAX_ENTRIES);

    const rebuiltIndex = storageStore[TRANSLATION_CACHE_INDEX_KEY] as {
      version: number;
      entries: Record<string, unknown>;
    };
    expect(Object.keys(rebuiltIndex.entries)).toHaveLength(TRANSLATION_CACHE_MAX_ENTRIES);
    expect(rebuiltIndex.entries[staleKey]).toBeUndefined();
  });
});
