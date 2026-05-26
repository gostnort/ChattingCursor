export interface AssistantBubbleColors {
  background: string;
  text: string;
  border: string;
}


export type AssistantBubbleColorKey = keyof AssistantBubbleColors;


export const ASSISTANT_BUBBLE_COLOR_KEYS: Record<AssistantBubbleColorKey, string> = {
  background: "assistantBubbleBackgroundColor",
  text: "assistantBubbleTextColor",
  border: "assistantBubbleBorderColor",
};


export const DEFAULT_ASSISTANT_BUBBLE_COLORS: AssistantBubbleColors = {
  background: "#0d1117",
  text: "#f8fafc",
  border: "#2ea043",
};


export function normalizeHexColor(value: string): string | null {
  const trimmed = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
    const compact = trimmed.slice(1).toLowerCase();
    return `#${compact[0]}${compact[0]}${compact[1]}${compact[1]}${compact[2]}${compact[2]}`;
  }
  return null;
}


function readStoredColor(key: AssistantBubbleColorKey): string {
  const stored = localStorage.getItem(ASSISTANT_BUBBLE_COLOR_KEYS[key]);
  return normalizeHexColor(stored ?? "") ?? DEFAULT_ASSISTANT_BUBBLE_COLORS[key];
}


export function getAssistantBubbleColors(): AssistantBubbleColors {
  return {
    background: readStoredColor("background"),
    text: readStoredColor("text"),
    border: readStoredColor("border"),
  };
}


export function setAssistantBubbleColors(colors: AssistantBubbleColors): AssistantBubbleColors {
  const normalized = {
    background: normalizeHexColor(colors.background) ?? DEFAULT_ASSISTANT_BUBBLE_COLORS.background,
    text: normalizeHexColor(colors.text) ?? DEFAULT_ASSISTANT_BUBBLE_COLORS.text,
    border: normalizeHexColor(colors.border) ?? DEFAULT_ASSISTANT_BUBBLE_COLORS.border,
  };
  localStorage.setItem(ASSISTANT_BUBBLE_COLOR_KEYS.background, normalized.background);
  localStorage.setItem(ASSISTANT_BUBBLE_COLOR_KEYS.text, normalized.text);
  localStorage.setItem(ASSISTANT_BUBBLE_COLOR_KEYS.border, normalized.border);
  return normalized;
}
