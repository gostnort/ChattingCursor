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


/** 判断节点是否落在指定气泡正文内 */
function isNodeInsideBubbleText(node: Node | null, bubbleText: HTMLElement): boolean {
  if (!node) {
    return false;
  }
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as HTMLElement;
  return Boolean(element?.closest(".bubble-text") === bubbleText);
}


/** 将选区限制在已聚焦消息的气泡正文内（移动端长按全选等） */
export function clampSelectionToFocusedBubble(focusedMessageId: string): void {
  if (isEditableFocusedTarget(document.activeElement)) {
    return;
  }
  const bubbleText = document.querySelector<HTMLElement>(
    `[data-message-id="${focusedMessageId}"] .bubble-text`,
  );
  if (!bubbleText) {
    return;
  }
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return;
  }
  const anchorInside = isNodeInsideBubbleText(selection.anchorNode, bubbleText);
  const focusInside = isNodeInsideBubbleText(selection.focusNode, bubbleText);
  if (anchorInside && focusInside) {
    return;
  }
  selectElementText(bubbleText);
}
