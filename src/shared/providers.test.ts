import {
  createGoogleRequest,
  createOpenAIRequest,
  parseOpenAITranslations,
  resetProviderRuntimeState,
  translateTexts,
  translateTextsDetailed
} from "./providers";
import { mergeSettings } from "./settings";
import { GLOSSARY_STORAGE_KEY } from "./glossary";
import {
  buildTranslationCacheKey,
  TRANSLATION_CACHE_TTL_MS
} from "./translation-cache";
import type { GlossaryTerm } from "./types";

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
    resetProviderRuntimeState();

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
    const request = createOpenAIRequest(
      ["The API stays stable."],
      openAISettings,
      "selection",
      "rich",
      [
        {
          id: "api",
          sourceText: "API",
          targetText: "接口",
          enabled: true,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    );
    const requestBody = JSON.parse(request.init.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMessage = requestBody.messages.find((message) => message.role === "system");
    const userMessage = requestBody.messages.find((message) => message.role === "user");
    const userPayload = JSON.parse(userMessage?.content ?? "{}") as {
      scene?: string;
      style?: string;
      glossary?: Array<{ source: string; target: string }>;
      output?: { preserveOrder?: boolean };
    };

    expect(request.url).toBe("https://api.example.com/v1/chat/completions");
    expect((request.init.headers as Record<string, string>).Authorization).toContain("openai-key");
    expect(request.init.body).not.toContain("response_format");
    expect(systemMessage?.content).toContain("selection-based lookup");
    expect(userPayload.scene).toBe("selection");
    expect(userPayload.style).toContain("适合划词即看");
    expect(userPayload.glossary).toEqual([{ source: "API", target: "接口" }]);
    expect(userPayload.output?.preserveOrder).toBe(true);
  });

  it("does not include unmatched openai glossary terms", () => {
    const request = createOpenAIRequest(
      ["No matching term here."],
      openAISettings,
      "selection",
      "rich",
      [
        {
          id: "api",
          sourceText: "API",
          targetText: "接口",
          enabled: true,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    );
    const requestBody = JSON.parse(request.init.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMessage = requestBody.messages.find((message) => message.role === "user");
    const userPayload = JSON.parse(userMessage?.content ?? "{}") as {
      glossary?: unknown[];
    };

    expect(userPayload.glossary).toEqual([]);
  });

  it("builds a paragraph-oriented prompt for immersive reading", () => {
    const request = createOpenAIRequest(["A longer paragraph."], openAISettings, "page");
    const requestBody = JSON.parse(request.init.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemMessage = requestBody.messages.find((message) => message.role === "system");
    const userMessage = requestBody.messages.find((message) => message.role === "user");
    const userPayload = JSON.parse(userMessage?.content ?? "{}") as {
      scene?: string;
      style?: string;
    };

    expect(systemMessage?.content).toContain("immersive bilingual reading");
    expect(systemMessage?.content).toContain("paragraph-level readability");
    expect(userPayload.scene).toBe("page");
    expect(userPayload.style).toContain("适合整段阅读");
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

  it("passes abort signals through to provider fetch requests", async () => {
    const openAIResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: '{"translations":["你好"]}' } }]
      })
    } as unknown as Response;

    const openAIFetcher = vi.fn().mockResolvedValue(openAIResponse);
    const controller = new AbortController();

    await expect(
      translateTexts(["Hello"], openAISettings, openAIFetcher, controller.signal)
    ).resolves.toEqual(["你好"]);

    expect(openAIFetcher).toHaveBeenCalledWith(
      "https://api.example.com/v1/chat/completions",
      expect.objectContaining({
        signal: controller.signal
      })
    );
  });

  it("retries transient 502 responses before succeeding", async () => {
    const temporaryFailure = {
      ok: false,
      status: 502,
      text: vi.fn().mockResolvedValue("")
    } as unknown as Response;
    const success = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: '{"translations":["你好"]}' } }]
      })
    } as unknown as Response;

    const openAIFetcher = vi
      .fn()
      .mockResolvedValueOnce(temporaryFailure)
      .mockResolvedValueOnce(success);

    await expect(
      translateTexts(["Hello"], openAISettings, openAIFetcher)
    ).resolves.toEqual(["你好"]);
    expect(openAIFetcher).toHaveBeenCalledTimes(2);
  });

  it("returns a friendlier message after repeated 502 responses", async () => {
    const temporaryFailure = {
      ok: false,
      status: 502,
      text: vi.fn().mockResolvedValue("")
    } as unknown as Response;

    const openAIFetcher = vi.fn().mockResolvedValue(temporaryFailure);

    await expect(
      translateTexts(["Hello"], openAISettings, openAIFetcher)
    ).rejects.toMatchObject({
      details: {
        code: "PROVIDER_ERROR",
        message: "远程翻译接口暂时不可用（502），请稍后重试。"
      }
    });
    expect(openAIFetcher).toHaveBeenCalledTimes(6);
  });

  it("falls back to a minimal compatibility request after repeated provider failures", async () => {
    const temporaryFailure = {
      ok: false,
      status: 502,
      text: vi.fn().mockResolvedValue("")
    } as unknown as Response;
    const success = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: '{"translations":["你好"]}' } }]
      })
    } as unknown as Response;

    const openAIFetcher = vi
      .fn()
      .mockResolvedValueOnce(temporaryFailure)
      .mockResolvedValueOnce(temporaryFailure)
      .mockResolvedValueOnce(temporaryFailure)
      .mockResolvedValueOnce(success);

    await expect(
      translateTexts(["Hello"], openAISettings, openAIFetcher)
    ).resolves.toEqual(["你好"]);

    const fallbackRequestBody = JSON.parse(
      openAIFetcher.mock.calls[3]?.[1]?.body as string
    ) as {
      temperature?: number;
      response_format?: unknown;
      messages: Array<{ role: string; content: string }>;
    };

    expect(fallbackRequestBody.temperature).toBeUndefined();
    expect(fallbackRequestBody.response_format).toBeUndefined();
    expect(fallbackRequestBody.messages[0]?.content).toContain("Return JSON only");
    expect(fallbackRequestBody.messages[1]?.content).toContain("[1] Hello");
  });

  it("reuses the remembered compatibility mode so later requests skip the slow rich fallback", async () => {
    const temporaryFailure = {
      ok: false,
      status: 502,
      text: vi.fn().mockResolvedValue("")
    } as unknown as Response;
    const firstSuccess = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: '{"translations":["你好"]}' } }]
      })
    } as unknown as Response;
    const secondSuccess = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: '{"translations":["世界"]}' } }]
      })
    } as unknown as Response;

    const openAIFetcher = vi
      .fn()
      .mockResolvedValueOnce(temporaryFailure)
      .mockResolvedValueOnce(temporaryFailure)
      .mockResolvedValueOnce(temporaryFailure)
      .mockResolvedValueOnce(firstSuccess)
      .mockResolvedValueOnce(secondSuccess);

    await expect(
      translateTexts(["Hello"], openAISettings, openAIFetcher)
    ).resolves.toEqual(["你好"]);
    await expect(
      translateTexts(["World"], openAISettings, openAIFetcher)
    ).resolves.toEqual(["世界"]);

    expect(openAIFetcher).toHaveBeenCalledTimes(5);

    const secondRequestBody = JSON.parse(
      openAIFetcher.mock.calls[4]?.[1]?.body as string
    ) as {
      temperature?: number;
      messages: Array<{ role: string; content: string }>;
    };

    expect(secondRequestBody.temperature).toBeUndefined();
    expect(secondRequestBody.messages[0]?.content).toContain("Return JSON only");
  });

  it("splits page batches into smaller requests after transient provider failures", async () => {
    const temporaryFailure = {
      ok: false,
      status: 502,
      text: vi.fn().mockResolvedValue("")
    } as unknown as Response;
    const leftSuccess = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: '{"translations":["第一段"]}' } }]
      })
    } as unknown as Response;
    const rightSuccess = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: '{"translations":["第二段"]}' } }]
      })
    } as unknown as Response;

    const openAIFetcher = vi
      .fn()
      .mockResolvedValueOnce(temporaryFailure)
      .mockResolvedValueOnce(temporaryFailure)
      .mockResolvedValueOnce(temporaryFailure)
      .mockResolvedValueOnce(temporaryFailure)
      .mockResolvedValueOnce(temporaryFailure)
      .mockResolvedValueOnce(temporaryFailure)
      .mockResolvedValueOnce(leftSuccess)
      .mockResolvedValueOnce(rightSuccess);

    await expect(
      translateTextsDetailed(
        ["First paragraph.", "Second paragraph."],
        openAISettings,
        openAIFetcher,
        false,
        undefined,
        "page"
      )
    ).resolves.toEqual({
      translations: ["第一段", "第二段"],
      meta: {
        cacheHits: 0,
        requestedCount: 2,
        networkCount: 2
      }
    });

    expect(openAIFetcher).toHaveBeenCalledTimes(8);
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

  it("stores cache entries with only the glossary sent in the openai request", async () => {
    const apiTerm: GlossaryTerm = {
      id: "api",
      sourceText: "API",
      targetText: "接口",
      enabled: true,
      createdAt: 1,
      updatedAt: 1
    };
    const longTerms: GlossaryTerm[] = Array.from({ length: 50 }, (_, index) => ({
      id: `long-${index}`,
      sourceText: `VeryLongTechnicalTerm${index.toString().padStart(2, "0")}`,
      targetText: `长术语${index}`,
      enabled: true,
      createdAt: 2 + index,
      updatedAt: 2 + index
    }));
    const longText = longTerms
      .map((term) => term.sourceText)
      .join(" is documented with ");
    const apiText = "The API stays stable across releases.";
    storageStore[GLOSSARY_STORAGE_KEY] = {
      version: 1,
      terms: [apiTerm, ...longTerms]
    };
    const openAIResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [
          {
            message: {
              content: '{"translations":["长术语译文","API 旧译文"]}'
            }
          }
        ]
      })
    } as unknown as Response;
    const openAIFetcher = vi.fn().mockResolvedValue(openAIResponse);

    await expect(
      translateTextsDetailed([longText, apiText], openAISettings, openAIFetcher)
    ).resolves.toEqual({
      translations: ["长术语译文", "API 旧译文"],
      meta: {
        cacheHits: 0,
        requestedCount: 2,
        networkCount: 2
      }
    });

    const requestBody = JSON.parse(
      openAIFetcher.mock.calls[0][1]?.body as string
    ) as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMessage = requestBody.messages.find((message) => message.role === "user");
    const userPayload = JSON.parse(userMessage?.content ?? "{}") as {
      glossary: Array<{ source: string; target: string }>;
    };
    const apiKeyWithoutSentGlossary = await buildTranslationCacheKey(
      openAISettings,
      apiText
    );
    const apiKeyWithApiGlossary = await buildTranslationCacheKey(openAISettings, apiText, [
      apiTerm
    ]);

    expect(userPayload.glossary).toHaveLength(50);
    expect(userPayload.glossary.some((term) => term.source === "API")).toBe(false);
    expect(storageStore[apiKeyWithoutSentGlossary]).toMatchObject({
      translation: "API 旧译文"
    });
    expect(storageStore[apiKeyWithApiGlossary]).toBeUndefined();
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

  it("rethrows abort errors instead of wrapping them as network failures", async () => {
    const controller = new AbortController();
    const openAIFetcher = vi.fn(
      async (_url: URL | RequestInfo, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }

          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        })
    );

    const translationPromise = translateTexts(
      ["Hello"],
      openAISettings,
      openAIFetcher,
      controller.signal
    );
    queueMicrotask(() => {
      controller.abort();
    });

    await expect(translationPromise).rejects.toMatchObject({
      name: "AbortError"
    });
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

    const controller = new AbortController();
    const seenSignals: Array<AbortSignal | null | undefined> = [];
    const responses = [batchResponse, singleResponseOne, singleResponseTwo];
    const openAIFetcher = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      seenSignals.push(init?.signal);
      return responses.shift() as Response;
    });

    await expect(
      translateTexts(
        ["First sentence", "Second sentence"],
        openAISettings,
        openAIFetcher,
        controller.signal
      )
    ).resolves.toEqual(["第一句译文", "第二句译文"]);

    expect(openAIFetcher).toHaveBeenCalledTimes(3);
    expect(seenSignals).toEqual([
      controller.signal,
      controller.signal,
      controller.signal
    ]);
  });
});
