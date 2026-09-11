type FrameCallback = (time: number) => void;
/**
 * Shared frame and time source for live rendering and deterministic preview.
 */
export declare class RuntimeClock {
    private static manual;
    private static fps;
    private static time;
    private static frame;
    private static sequence;
    private static generationValue;
    private static frames;
    private static timers;
    static get isManual(): boolean;
    static get frameCount(): number;
    static get generation(): number;
    static get frameDuration(): number;
    static now(): number;
    static useManual(fps?: number): void;
    static useAutomatic(): void;
    static requestFrame(callback: FrameCallback): number;
    static requestLayout(callback: FrameCallback): number;
    static cancelFrame(id: number): void;
    private static addFrame;
    private static scheduleFrame;
    /**
     * Flushes queued visual work without executing application animation frames.
     */
    static flushLayout(): void;
    /**
     * Advances to the first simulation frame at or after the requested time.
     */
    static advanceTo(timeMs: number, beforeFrame?: (time: number, frame: number) => void): void;
    /**
     * Advances fixed frames with an asynchronous pre-frame hook and microtask checkpoint.
     */
    static advanceToAsync(timeMs: number, beforeFrame?: (time: number, frame: number) => void | Promise<void>): Promise<void>;
    private static targetFrame;
    private static flushFrame;
    static setTimeout(callback: () => void, delayMs?: number): number;
    static setInterval(callback: () => void, delayMs?: number): number;
    static clearTimer(id: number): void;
    private static addTimer;
    private static scheduleTimer;
    private static flushTimers;
}
export {};
