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
    expect(clearImmersiveTranslations(document)).toBe(2);
    expect(hasImmersiveTranslations(document)).toBe(false);
  });
});
