import type { ThemeName } from "../shared/types";

const storageKey = "custom-gpt-theme";

export const themes: ThemeName[] = ["white", "sapphire", "black"];

export const readStoredTheme = (): ThemeName => {
  const stored = localStorage.getItem(storageKey) as ThemeName | null;
  return stored && themes.includes(stored) ? stored : "white";
};

export const applyTheme = (theme: ThemeName): void => {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(storageKey, theme);
};
