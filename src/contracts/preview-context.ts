import type * as FairyGUI from '@magicskysword/fairygui-dom';

export type PreviewJSON = null | boolean | number | string | PreviewJSON[] | { [key: string]: PreviewJSON };

/**
 * JavaScript context available in preconstruct, setup and timeline scripts.
 */
export interface PreviewContext {
  /** Undefined during preconstruct; the source component after construction. */
  readonly root: FairyGUI.GComponent | undefined;
  readonly fgui: typeof FairyGUI;
  readonly data: PreviewJSON;
  query(selector: string): FairyGUI.GObject[];
  one(selector?: string): FairyGUI.GObject;
  ref(object: FairyGUI.GObject): string;
  resolve(reference: string): FairyGUI.GObject | undefined;
  readonly resources: { url(name: string): string };
  readonly clock: {
    /** Milliseconds from the preview time origin. */
    now(): number;
    setTimeout(callback: () => void, delayMs?: number): number;
    setInterval(callback: () => void, delayMs?: number): number;
    clear(timer: number): void;
    requestFrame(callback: (timeMs: number) => void): number;
    cancelFrame(frame: number): void;
  };
  log(...values: unknown[]): void;
  warn(...values: unknown[]): void;
}

export type InitializedPreviewContext = PreviewContext & { readonly root: FairyGUI.GComponent };
export type PreviewScript = (ctx: PreviewContext, fgui: typeof FairyGUI) => void | Promise<void>;
