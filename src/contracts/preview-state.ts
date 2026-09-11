export interface PreviewNode {
  ref: string; id: string; name: string; type: string; parentRef?: string;
  props: Record<string, unknown>; controllers: unknown[]; gears: unknown[]; transitions: unknown[];
}
export interface PreviewState { time: number; frame: number; nodes: PreviewNode[]; logs: Array<{ level: string; message: string; time: number }>; }
export interface PreviewFrame extends PreviewState { requestedTime: number; png: Uint8Array; }
export interface PreviewFailure { code: string; message: string; path?: string; stack?: string; time?: number; }
export interface PreviewRunResult { complete: boolean; frames: PreviewFrame[]; state: PreviewState; error?: PreviewFailure; }

export interface PreviewSource { projectId: string; packageId: string; componentId: string; planId?: string | undefined; }
export interface PreviewData {
  previewId: string;
  status: 'ready' | 'failed' | 'closed';
  source: PreviewSource;
  sourceStatus: 'current' | 'changed' | 'plan';
  snapshotFingerprint: string;
  recipeHash: string;
  seed: number;
  runtimeVersions: Record<string, string>;
  cacheHit: boolean;
  complete: boolean;
  state: PreviewState;
  frames: Array<Omit<PreviewFrame, 'png'> & { path: string }>;
  contactSheet?: { path: string; width: number; height: number };
  images: Array<{ mimeType: 'image/png'; data: string }>;
  error?: PreviewFailure;
}

/** Image data is carried in MCP image blocks, referenced by zero-based content index. */
export type PreviewToolData = Omit<PreviewData, 'images'> & { images: Array<{ mimeType: 'image/png'; contentIndex: number }> };
