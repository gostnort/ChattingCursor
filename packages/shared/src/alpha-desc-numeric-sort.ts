type SortToken = { kind: "text"; value: string } | { kind: "number"; value: number };


/** 将字符串拆成文字段与数字段，供排序比较 */
function tokenizeSortKey(value: string): SortToken[] {
  const tokens: SortToken[] = [];
  const pattern = /(\d+(?:\.\d+)?)|([^\d]+)/g;
  let match: RegExpExecArray | null = pattern.exec(value);
  while (match !== null) {
    if (match[1] !== undefined) {
      tokens.push({ kind: "number", value: Number(match[1]) });
    } else if (match[2] !== undefined) {
      tokens.push({ kind: "text", value: match[2] });
    }
    match = pattern.exec(value);
  }
  return tokens;
}


/** 字母 A-Z 排序；同位置数字段降序（大数在前） */
export function compareAlphaDescNumeric(left: string, right: string): number {
  const leftTokens = tokenizeSortKey(left);
  const rightTokens = tokenizeSortKey(right);
  const maxLen = Math.max(leftTokens.length, rightTokens.length);
  for (let index = 0; index < maxLen; index += 1) {
    const leftToken = leftTokens[index];
    const rightToken = rightTokens[index];
    if (leftToken === undefined) {
      return -1;
    }
    if (rightToken === undefined) {
      return 1;
    }
    if (leftToken.kind === "number" && rightToken.kind === "number") {
      if (leftToken.value !== rightToken.value) {
        return rightToken.value - leftToken.value;
      }
      continue;
    }
    if (leftToken.kind === "text" && rightToken.kind === "text") {
      const diff = leftToken.value.localeCompare(rightToken.value, undefined, { sensitivity: "base" });
      if (diff !== 0) {
        return diff;
      }
      continue;
    }
    if (leftToken.kind === "text") {
      return -1;
    }
    return 1;
  }
  return 0;
}


/** 按 selector 返回值做 alpha-desc-numeric 排序（返回新数组） */
export function sortAlphaDescNumeric<T>(items: readonly T[], selector: (item: T) => string): T[] {
  return [...items].sort((left, right) => compareAlphaDescNumeric(selector(left), selector(right)));
}
