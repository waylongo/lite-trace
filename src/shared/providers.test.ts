import {
  createGoogleRequest,
  createOpenAIRequest,
  parseOpenAITranslations,
  translateTexts,
  translateTextsDetailed
} from "./providers";
import { mergeSettings } from "./settings";
import {
  buildTranslationCacheKey,
  TRANSLATION_CACHE_TTL_MS
} from "./translation-cache";

const googleSettings = mergeSettings({
  activeProvider: "google",
  google: { apiKey: "google-key" }
});

const openAISettings = mergeSettings({
  activeProvider: "openai",
  openai: {
    baseUrl: "https://api.example.com/v1",
    model: "demo-model",
    apiKey: "openai-key"
  }
});

describe("provider helpers", () => {
  let storageStore: Record<string, unknown>;

  beforeEach(() => {
    storageStore = {};

    vi.stubGlobal("chrome", {
      permissions: {
        contains: vi.fn().mockResolvedValue(true)
      },
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

  it("builds google translate requests", () => {
    const request = createGoogleRequest(["Hello"], googleSettings);
    expect(request.url).toContain("translation.googleapis.com");
    expect(request.init.method).toBe("POST");
  });

  it("builds openai-compatible requests", () => {
    const request = createOpenAIRequest(["Hello"], openAISettings);
    expect(request.url).toBe("https://api.example.com/v1/chat/completions");
    expect((request.init.headers as Record<string, string>).Authorization).toContain("openai-key");
    expect(request.init.body).not.toContain("response_format");
  });

  it("adds json response_format for official openai endpoints", () => {
    const request = createOpenAIRequest(
      ["Hello"],
      mergeSettings({
        activeProvider: "openai",
        openai: {
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4.1-mini",
          apiKey: "openai-key"
        }
      })
    );

    expect(request.init.body).toContain("\"response_format\":{\"type\":\"json_object\"}");
  });

  it("parses strict json responses from llms", () => {
    expect(parseOpenAITranslations('{"translations":["你好","世界"]}', 2)).toEqual([
      "你好",
      "世界"
    ]);
    expect(
      parseOpenAITranslations("```json\n{\"translations\":[\"你好\"]}\n```", 1)
    ).toEqual(["你好"]);
    expect(parseOpenAITranslations("翻译：你好，世界。", 1)).toEqual(["你好，世界。"]);
    expect(parseOpenAITranslations("1. 你好\n2. 世界", 2)).toEqual([
      "你好",
      "世界"
    ]);
    expect(
      parseOpenAITranslations("<think>long hidden reasoning</think>翻译：你好，世界。", 1)
    ).toEqual(["你好，世界。"]);
    expect(
      parseOpenAITranslations(
        '<think>internal notes</think>{"translations":["你好"]}',
        1
      )
    ).toEqual(["你好"]);
  });

  it("translates via the active provider", async () => {
    const googleResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        data: {
          translations: [{ translatedText: "你好" }]
        }
      })
    } as unknown as Response;

    const openAIResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: '{"translations":["你好"]}' } }]
      })
    } as unknown as Response;

    const googleFetcher = vi.fn().mockResolvedValue(googleResponse);
    const openAIFetcher = vi.fn().mockResolvedValue(openAIResponse);

    await expect(translateTexts(["Hello"], googleSettings, googleFetcher)).resolves.toEqual([
      "你好"
    ]);
    await expect(translateTexts(["Hello"], openAISettings, openAIFetcher)).resolves.toEqual([
      "你好"
    ]);
  });

  it("reuses persistent cache before issuing a network request", async () => {
    const key = await buildTranslationCacheKey(openAISettings, "Hello");
    const now = Date.now();

    storageStore[key] = {
      translation: "缓存译文",
      createdAt: now,
      lastUsedAt: now
    };

    const openAIFetcher = vi.fn();

    await expect(translateTexts(["Hello"], openAISettings, openAIFetcher)).resolves.toEqual([
      "缓存译文"
    ]);

    expect(openAIFetcher).not.toHaveBeenCalled();
  });

  it("returns cache and network metadata while backfilling misses", async () => {
    const cachedKey = await buildTranslationCacheKey(openAISettings, "Hello");
    const now = Date.now();

    storageStore[cachedKey] = {
      translation: "你好",
      createdAt: now,
      lastUsedAt: now
    };

    const openAIResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: '{"translations":["世界"]}' } }]
      })
    } as unknown as Response;

    const openAIFetcher = vi.fn().mockResolvedValue(openAIResponse);

    await expect(
      translateTextsDetailed(["Hello", "World"], openAISettings, openAIFetcher)
    ).resolves.toEqual({
      translations: ["你好", "世界"],
      meta: {
        cacheHits: 1,
        requestedCount: 2,
        networkCount: 1
      }
    });

    const storedWorldKey = await buildTranslationCacheKey(openAISettings, "World");
    expect(storageStore[storedWorldKey]).toMatchObject({
      translation: "世界"
    });
  });

  it("ignores expired cache entries and refetches fresh translations", async () => {
    const key = await buildTranslationCacheKey(openAISettings, "Hello");
    const expiredAt = Date.now() - TRANSLATION_CACHE_TTL_MS - 10;

    storageStore[key] = {
      translation: "过期译文",
      createdAt: expiredAt,
      lastUsedAt: expiredAt
    };

    const openAIResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: '{"translations":["新译文"]}' } }]
      })
    } as unknown as Response;

    const openAIFetcher = vi.fn().mockResolvedValue(openAIResponse);

    await expect(translateTexts(["Hello"], openAISettings, openAIFetcher)).resolves.toEqual([
      "新译文"
    ]);

    expect(openAIFetcher).toHaveBeenCalledTimes(1);
  });

  it("reads content arrays returned by some compatible apis", async () => {
    const openAIResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: [{ type: "text", text: "翻译：你好" }]
            }
          }
        ]
      })
    } as unknown as Response;

    const openAIFetcher = vi.fn().mockResolvedValue(openAIResponse);

    await expect(translateTexts(["Hello"], openAISettings, openAIFetcher)).resolves.toEqual([
      "你好"
    ]);
  });

  it("strips think tags from compatible api content", async () => {
    const openAIResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: "<think>reasoning trace</think>翻译：你好"
            }
          }
        ]
      })
    } as unknown as Response;

    const openAIFetcher = vi.fn().mockResolvedValue(openAIResponse);

    await expect(translateTexts(["Hello"], openAISettings, openAIFetcher)).resolves.toEqual([
      "你好"
    ]);
  });

  it("falls back to single-item translations when batch parsing fails", async () => {
    const batchResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: "你好" } }]
      })
    } as unknown as Response;

    const singleResponseOne = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: "第一句译文" } }]
      })
    } as unknown as Response;

    const singleResponseTwo = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: "第二句译文" } }]
      })
    } as unknown as Response;

    const openAIFetcher = vi
      .fn()
      .mockResolvedValueOnce(batchResponse)
      .mockResolvedValueOnce(singleResponseOne)
      .mockResolvedValueOnce(singleResponseTwo);

    await expect(
      translateTexts(["First sentence", "Second sentence"], openAISettings, openAIFetcher)
    ).resolves.toEqual(["第一句译文", "第二句译文"]);

    expect(openAIFetcher).toHaveBeenCalledTimes(3);
  });
});
