export type Constructor<T = {}> = new (...args: any[]) => T;
export declare function convertToHtmlColor(rgb: number): string;
export declare function clamp(value: number, min: number, max: number): number;
export declare function clamp01(value: number): number;
export declare function lerp(start: number, end: number, percent: number): number;
export declare function repeat(t: number, length: number): number;
export declare function distance(x1: number, y1: number, x2: number, y2: number): number;
