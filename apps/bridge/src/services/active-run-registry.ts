/** 可取消的活跃 chat run（CLI 子进程、本地 LLM fetch 等） */
type RunCancelFn = () => void;


const activeRuns = new Map<string, RunCancelFn>();


export function registerActiveRun(runId: string, cancel: RunCancelFn): void {
  activeRuns.set(runId, cancel);
}


export function unregisterActiveRun(runId: string): void {
  activeRuns.delete(runId);
}


export function cancelActiveRun(runId: string): boolean {
  const cancel = activeRuns.get(runId);
  if (!cancel) {
    return false;
  }
  activeRuns.delete(runId);
  cancel();
  return true;
}


export function hasActiveRun(runId: string): boolean {
  return activeRuns.has(runId);
}
