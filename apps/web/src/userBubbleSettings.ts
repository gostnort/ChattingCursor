import { normalizeHexColor } from "./assistantBubbleSettings";


export const USER_BUBBLE_BACKGROUND_KEY = "userBubbleBackground";

export const DEFAULT_USER_BUBBLE_BACKGROUND = "#238636";


export function getUserBubbleBackground(): string {
  const stored = localStorage.getItem(USER_BUBBLE_BACKGROUND_KEY);
  return normalizeHexColor(stored ?? "") ?? DEFAULT_USER_BUBBLE_BACKGROUND;
}


export function setUserBubbleBackground(value: string): string {
  const normalized = normalizeHexColor(value) ?? DEFAULT_USER_BUBBLE_BACKGROUND;
  localStorage.setItem(USER_BUBBLE_BACKGROUND_KEY, normalized);
  return normalized;
}
