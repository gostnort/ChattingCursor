import type { RunEvent } from "@chatting-cursor/shared";


/** 单次 CLI 运行状态 */
export type RunStatus = "pending" | "running" | "finished" | "error";


export interface StoredRun {
  runId: string;
  status: RunStatus;
  events: RunEvent[];
  subscribers: Set<(event: RunEvent) => void>;
  createdAt: string;
  updatedAt: string;
}


/** 内存 Run 存储，用于 SSE 推送与回放 */
export class RunStore {
  private runs = new Map<string, StoredRun>();


  create(runId: string): StoredRun {
    const run: StoredRun = {
      runId,
      status: "pending",
      events: [],
      subscribers: new Set(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.runs.set(runId, run);
    return run;
  }


  get(runId: string): StoredRun | undefined {
    return this.runs.get(runId);
  }


  appendEvent(runId: string, event: RunEvent): void {
    const run = this.runs.get(runId);
    if (!run) {
      return;
    }
    run.events.push(event);
    run.updatedAt = event.timestamp;
    if (event.type === "run_started") {
      run.status = "running";
    }
    if (event.type === "error") {
      run.status = "error";
    }
    if (event.type === "run_finished") {
      run.status = "finished";
    }
    for (const subscriber of run.subscribers) {
      subscriber(event);
    }
  }


  subscribe(runId: string, listener: (event: RunEvent) => void): (() => void) | null {
    const run = this.runs.get(runId);
    if (!run) {
      return null;
    }
    run.subscribers.add(listener);
    return () => {
      run.subscribers.delete(listener);
    };
  }


  getRecent(): StoredRun | null {
    const runs = [...this.runs.values()];
    if (runs.length === 0) {
      return null;
    }
    runs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return runs[0] ?? null;
  }
}


export const runStore = new RunStore();
