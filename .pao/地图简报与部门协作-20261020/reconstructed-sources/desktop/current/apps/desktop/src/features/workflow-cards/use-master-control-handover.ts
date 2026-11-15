import { useCallback, useState } from "react";

/**
 * 把页面里的「请主控去做这件事」交给当前主控会话时的语义（计划 §7.2）。
 *
 * 页面自己没有写盘通道：改步骤、存模板、提意见都只是**一句话**，必须由主控用内核工具落盘。
 * 难点在输入框是用户正在打字的地方：
 *
 * - 输入框是空的时候，直接把这句话放进去最省事，也是用户期待的「帮我填好，我按回车」。
 * - 输入框非空时**绝不能覆盖**：用户可能打了半句话，覆盖掉就是替他丢字。这时把请求
 *   暂存成一条待办，由用户自己决定「用这句替换」还是「拼在我这句后面」。
 *
 * 暂存态只活在页面内存里，不写盘、不落会话，所以「仅形成草稿」不会被误报成已修改/已送达。
 */
export interface PendingHandover {
  /** 要交给主控的那句现成指令。 */
  readonly text: string;
  /** 交给用户看的来源说明（例如「第 2 步的修改」），用于待办行上的定位。 */
  readonly label?: string;
}

export interface MasterControlHandover {
  /** 当前被暂存的请求；没有就是 undefined。 */
  readonly pending: PendingHandover | undefined;
  /**
   * 把一句现成指令交给主控输入框。
   * `replace`＝替换用户已经打的内容（只在用户明确选择时用）。
   * 返回 'placed'（已放进空输入框）或 'held'（输入框非空，暂存等用户决定）。
   */
  readonly handover: (text: string, options?: { label?: string; replace?: boolean }) => "placed" | "held";
  /** 用户选择「拼在我这句后面」：把暂存指令追加到现有草稿，保留用户原话。 */
  readonly appendPending: (currentDraft: string, separator?: string) => string | undefined;
  /** 用户选择「用这句替换」：返回要写进输入框的文本。 */
  readonly replaceWithPending: () => string | undefined;
  /** 丢弃暂存（用户点了「不用了」，或切走了对象）。 */
  readonly discardPending: () => void;
}

export function useMasterControlHandover(params: {
  /** 读当前草稿（用 ref 读，避免把每个按键都变成依赖）。 */
  readonly readDraft: () => string;
  /** 写输入框。 */
  readonly writeDraft: (text: string) => void;
}): MasterControlHandover {
  const { readDraft, writeDraft } = params;
  const [pending, setPending] = useState<PendingHandover | undefined>();

  const handover = useCallback<MasterControlHandover["handover"]>(
    (text, options) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        return "placed";
      }
      const draft = readDraft();
      // 输入框空着，或用户明确要求替换：直接放进去，这就是「帮我填好」。
      if (options?.replace === true || draft.trim().length === 0) {
        writeDraft(text);
        setPending(undefined);
        return "placed";
      }
      // 输入框非空且没被授权替换：暂存，等用户决定，绝不动他打好的字。
      setPending({ text, label: options?.label });
      return "held";
    },
    [readDraft, writeDraft],
  );

  const appendPending = useCallback<MasterControlHandover["appendPending"]>(
    (currentDraft, separator = "\n\n") => {
      if (!pending) return undefined;
      const joined =
        currentDraft.trim().length === 0
          ? pending.text
          : `${currentDraft.trimEnd()}${separator}${pending.text}`;
      writeDraft(joined);
      setPending(undefined);
      return joined;
    },
    [pending, writeDraft],
  );

  const replaceWithPending = useCallback(() => {
    if (!pending) return undefined;
    writeDraft(pending.text);
    setPending(undefined);
    return pending.text;
  }, [pending, writeDraft]);

  const discardPending = useCallback(() => setPending(undefined), []);

  return { pending, handover, appendPending, replaceWithPending, discardPending };
}
