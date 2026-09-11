export declare class Vec2 {
    x: number;
    y: number;
    constructor(x?: number, y?: number);
    set(x: number, y: number): Vec2;
    reset(): Vec2;
    distance(x: number, y: number): number;
    toString(): string;
    normalize(): void;
    copy(Vec2: Vec2): Vec2;
    clone(): Vec2;
    equals(another: Vec2): boolean;
}
