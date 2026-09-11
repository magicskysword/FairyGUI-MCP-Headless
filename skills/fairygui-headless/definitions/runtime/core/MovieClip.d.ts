import { Image } from "./Image";
export interface Frame {
    addDelay?: number;
    spriteId?: string;
    src?: string;
}
export declare class MovieClip extends Image {
    interval: number;
    swing: boolean;
    repeatDelay: number;
    timeScale: number;
    private _playing;
    private _frameCount;
    private _frames;
    private _frame;
    private _start;
    private _end;
    private _times;
    private _endAt;
    private _status;
    private _frameElapsed;
    private _reversed;
    private _repeatedCount;
    constructor();
    connectedCallback(): void;
    disconnectedCallback(): void;
    get frames(): Frame[];
    set frames(value: Frame[]);
    get frameCount(): number;
    get frame(): number;
    set frame(value: number);
    get playing(): boolean;
    set playing(value: boolean);
    rewind(): void;
    syncStatus(anotherMc: MovieClip): void;
    advance(timeInMiniseconds: number): void;
    setPlaySettings(start?: number, end?: number, times?: number, endAt?: number): void;
    private onTimer;
    private drawFrame;
    private checkTimer;
}
