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


/** 切换离线模型或释放离线栈时取消全部活跃 run */
export function cancelAllActiveRuns(): void {
  for (const [runId, cancel] of activeRuns.entries()) {
    try {
      cancel();
    } catch {
      // 忽略单个 run 取消失败
    }
    activeRuns.delete(runId);
  }
}
