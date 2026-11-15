import type { BrowserWindow, WebContents } from "electron";
import { desktopIpc } from "../../contracts/ipc";

interface LeaveRequest {
  readonly contents: WebContents;
  readonly requestId: number;
  readonly promise: Promise<boolean>;
  readonly finish: (allowed: boolean) => void;
}

/**
 * 保存对话由画布处理；主进程在批准前不关窗口、不切页、不停止会话。
 * 保存可能等待用户确认，不使用超时自动批准。重复关闭共用同一次选择：
 * 请求先占住一个 pending，无论随后走渲染层确认还是窗口无响应／崩溃时的原生兜底，
 * 同一窗口的并发请求都复用同一个 promise，因此只会出现一个选择框。
 */
export class WorkflowLeaveGuard {
  private nextRequestId = 1;
  private readonly pending = new Map<WebContents, LeaveRequest>();
  private readonly unresponsive = new WeakSet<BrowserWindow>();
  constructor(private readonly confirmUnavailable?: (window: BrowserWindow) => Promise<boolean>) {}
  watch(window: BrowserWindow): void {
    window.on("unresponsive", () => this.unresponsive.add(window));
    window.on("responsive", () => this.unresponsive.delete(window));
  }

  request(window: BrowserWindow): Promise<boolean> {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return Promise.resolve(true);
    const contents = window.webContents;
    // pending 必须先查：窗口无响应／崩溃时也要复用同一个选择，不能每个请求各弹一次原生框。
    const existing = this.pending.get(contents);
    if (existing) return existing.promise;
    const requestId = this.nextRequestId++;
    let resolveRequest!: (allowed: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      resolveRequest = resolve;
    });
    let settled = false;
    let prompting = false;
    const finish = (allowed: boolean) => {
      if (settled) return;
      settled = true;
      contents.off("destroyed", cancel);
      contents.off("render-process-gone", unavailable);
      window.off("unresponsive", unavailable);
      this.pending.delete(contents);
      resolveRequest(allowed);
    };
    const cancel = () => finish(false);
    // 原生兜底：读不到渲染层选择时让用户明确选「继续等待」或「放弃并离开」。
    // 同一请求只弹一次；原生对话框本身失败或抛错一律按不批准处理，绝不放行。
    const promptUnavailable = () => {
      if (settled || prompting) return;
      if (!this.confirmUnavailable) {
        finish(false);
        return;
      }
      prompting = true;
      let answer: Promise<boolean>;
      try {
        answer = this.confirmUnavailable(window);
      } catch (error) {
        console.error("[workflow-leave-guard] 无法显示退出选择", error);
        finish(false);
        return;
      }
      void answer.then(finish).catch((error: unknown) => {
        console.error("[workflow-leave-guard] 无法显示退出选择", error);
        finish(false);
      });
    };
    const unavailable = () => promptUnavailable();
    this.pending.set(contents, { contents, requestId, promise, finish });
    contents.once("destroyed", cancel);
    contents.once("render-process-gone", unavailable);
    window.once("unresponsive", unavailable);
    // 请求时窗口已不可用：直接走原生兜底，不发送只会有去无回的 IPC。
    if (contents.isCrashed() || this.unresponsive.has(window)) {
      promptUnavailable();
      return promise;
    }
    try {
      contents.send(desktopIpc.workflowLeaveRequested, requestId);
    } catch (error) {
      finish(false);
      return Promise.reject(error);
    }
    return promise;
  }

  async requestAll(windows: readonly BrowserWindow[]): Promise<boolean> {
    for (const window of windows) if (!(await this.request(window))) return false;
    return true;
  }

  acknowledge(contents: WebContents, requestId: number, allowed: boolean): void {
    const entry = this.pending.get(contents);
    if (entry?.requestId === requestId) entry.finish(allowed);
  }
}
