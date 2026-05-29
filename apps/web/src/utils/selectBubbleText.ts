/** 判断当前焦点是否在可编辑控件内（输入框应保留默认全选） */
export function isEditableFocusedTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
    return true;
  }
  if (active instanceof HTMLSelectElement) {
    return true;
  }
  if (active instanceof HTMLElement && active.isContentEditable) {
    return true;
  }
  return Boolean(target.closest("textarea, input, select, [contenteditable='true']"));
}


/** 选中元素内的全部文本 */
export function selectElementText(element: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}


/** 从选区端点向上查找所在气泡正文 */
function findBubbleTextFromNode(node: Node | null): HTMLElement | null {
  if (!node) {
    return null;
  }
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
  return element?.closest<HTMLElement>(".bubble-text") ?? null;
}


/** 选区是否完全落在指定气泡正文内 */
function isRangeFullyInside(element: HTMLElement, range: Range): boolean {
  return element.contains(range.startContainer) && element.contains(range.endContainer);
}


/** 将选区限制在气泡正文内（移动端长按全选等） */
export function clampSelectionToBubble(focusedMessageId: string | null): void {
  if (isEditableFocusedTarget(document.activeElement)) {
    return;
  }
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return;
  }
  const range = selection.getRangeAt(0);
  let bubbleText: HTMLElement | null = null;
  if (focusedMessageId) {
    bubbleText = document.querySelector<HTMLElement>(
      `[data-message-id="${focusedMessageId}"] .bubble-text`,
    );
  }
  if (!bubbleText) {
    bubbleText =
      findBubbleTextFromNode(selection.anchorNode) ?? findBubbleTextFromNode(selection.focusNode);
  }
  if (!bubbleText) {
    return;
  }
  if (isRangeFullyInside(bubbleText, range)) {
    return;
  }
  selectElementText(bubbleText);
}
