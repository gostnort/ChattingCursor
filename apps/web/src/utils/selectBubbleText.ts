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
