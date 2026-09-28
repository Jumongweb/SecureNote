import { describe, expect, it } from "vitest";
import { infoPanelPreference, nextAppearance } from "./preferences";

describe("workspace preferences", () => {
  it("cycles through all three appearance modes", () => {
    expect(nextAppearance("dark")).toBe("light");
    expect(nextAppearance("light")).toBe("focus");
    expect(nextAppearance("focus")).toBe("dark");
  });

  it("defaults the information panel to visible", () => {
    expect(infoPanelPreference(null)).toBe(true);
    expect(infoPanelPreference("closed")).toBe(false);
  });
});
