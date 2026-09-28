export type AppearanceMode = "dark" | "light" | "focus";

export function nextAppearance(current: AppearanceMode): AppearanceMode {
  const modes: AppearanceMode[] = ["dark", "light", "focus"];
  return modes[(modes.indexOf(current) + 1) % modes.length];
}

export function infoPanelPreference(value: string | null) {
  return value !== "closed";
}
