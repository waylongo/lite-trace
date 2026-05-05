import {
  getPermissionOriginsForProvider,
  mergeSettings,
  normalizeOpenAIBaseUrl,
  validateSettings
} from "./settings";

describe("settings helpers", () => {
  it("defaults new settings to OpenAI while preserving existing provider choices", () => {
    expect(mergeSettings({}).activeProvider).toBe("openai");
    expect(
      mergeSettings({
        activeProvider: "google",
        google: { apiKey: "key" }
      }).activeProvider
    ).toBe("google");
  });

  it("normalizes openai base urls", () => {
    expect(normalizeOpenAIBaseUrl("https://api.openai.com/v1/")).toBe(
      "https://api.openai.com/v1"
    );
    expect(normalizeOpenAIBaseUrl("https://demo.test/v1/chat/completions")).toBe(
      "https://demo.test/v1"
    );
  });

  it("validates provider settings", () => {
    expect(validateSettings(mergeSettings({ activeProvider: "google" }))).toContain(
      "Google Translate API Key 不能为空。"
    );
    expect(
      validateSettings(
        mergeSettings({
          activeProvider: "openai",
          openai: {
            baseUrl: "https://api.example.com/v1",
            model: "gpt-test",
            apiKey: "sk-demo"
          }
        })
      )
    ).toHaveLength(0);
  });

  it("derives the permission origin for the active provider", () => {
    expect(
      getPermissionOriginsForProvider(
        mergeSettings({
          activeProvider: "google",
          google: { apiKey: "key" }
        })
      )
    ).toEqual(["https://translation.googleapis.com/*"]);

    expect(
      getPermissionOriginsForProvider(
        mergeSettings({
          activeProvider: "openai",
          openai: {
            baseUrl: "https://api.example.com/v1",
            model: "gpt-test",
            apiKey: "sk-demo"
          }
        })
      )
    ).toEqual(["https://api.example.com/*"]);
  });

  it("keeps onboarding preference defaults compatible with older settings", () => {
    expect(mergeSettings({}).preferences).toMatchObject({
      hasCompletedSetup: false,
      hasSeenReadingCoachmark: false
    });

    expect(
      mergeSettings({
        preferences: {
          hasCompletedSetup: true
        }
      }).preferences
    ).toMatchObject({
      hasCompletedSetup: true,
      hasSeenReadingCoachmark: false
    });
  });
});
