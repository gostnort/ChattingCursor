export const TEXT_SIZE_KEY = "textSizePx";
export const DEFAULT_TEXT_SIZE_PX = 16;
export const MAX_TEXT_SIZE_PX = 20;


export function getTextSizePx(): number {
  const raw = localStorage.getItem(TEXT_SIZE_KEY);
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_TEXT_SIZE_PX;
  if (!Number.isInteger(parsed)) {
    return DEFAULT_TEXT_SIZE_PX;
  }
  return Math.min(Math.max(parsed, DEFAULT_TEXT_SIZE_PX), MAX_TEXT_SIZE_PX);
}


export function setTextSizePx(size: number): number {
  const normalized = Math.min(Math.max(Math.round(size), DEFAULT_TEXT_SIZE_PX), MAX_TEXT_SIZE_PX);
  localStorage.setItem(TEXT_SIZE_KEY, String(normalized));
  return normalized;
}
