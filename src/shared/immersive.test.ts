import {
  applyImmersiveTranslations,
  clearImmersiveTranslations,
  hasImmersiveTranslations
} from "./immersive";
import type { TranslatableBlock } from "./types";

describe("immersive translations", () => {
  function buildBlocks(): TranslatableBlock[] {
    document.body.innerHTML = `
      <main>
        <p id="one">First paragraph.</p>
        <p id="two">Second paragraph.</p>
      </main>
    `;

    return [
      {
        element: document.getElementById("one") as HTMLElement,
        text: "First paragraph."
      },
      {
        element: document.getElementById("two") as HTMLElement,
        text: "Second paragraph."
      }
    ];
  }

  it("applies translations after each block and can clear them", () => {
    const blocks = buildBlocks();
    expect(applyImmersiveTranslations(blocks, ["第一段", "第二段"])).toBe(2);
    expect(hasImmersiveTranslations(document)).toBe(true);
    expect(document.querySelectorAll("[data-litetrace-translation]")).toHaveLength(2);
    expect(document.querySelectorAll("[data-litetrace-source]")).toHaveLength(2);
    expect(clearImmersiveTranslations(document)).toBe(2);
    expect(hasImmersiveTranslations(document)).toBe(false);
    expect(document.querySelectorAll("[data-litetrace-source]")).toHaveLength(0);
  });

  it("keeps the translated block tag and primary attributes aligned with the source", () => {
    document.body.innerHTML = `
      <main>
        <h2 id="headline" class="article-title emphasis" style="letter-spacing: 0.02em" dir="ltr">
          Original title
        </h2>
      </main>
    `;

    const blocks: TranslatableBlock[] = [
      {
        element: document.getElementById("headline") as HTMLElement,
        text: "Original title"
      }
    ];

    expect(applyImmersiveTranslations(blocks, ["译文标题"])).toBe(1);

    const translationNode = document.querySelector(
      "[data-litetrace-translation]"
    ) as HTMLElement;

    expect(translationNode.tagName).toBe("H2");
    expect(translationNode.className).toContain("article-title");
    expect(translationNode.getAttribute("style")).toContain("letter-spacing");
    expect(translationNode.getAttribute("lang")).toBe("zh-CN");
    expect(translationNode.id).toBe("");
    expect(translationNode.textContent).toBe("译文标题");
  });
});
