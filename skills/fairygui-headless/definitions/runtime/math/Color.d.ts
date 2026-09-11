export declare class Color {
    static CLEAR: Color;
    static RED: Color;
    static GREEN: Color;
    static BLUE: Color;
    static YELLOW: Color;
    static GRAY: Color;
    static BLACK: Color;
    static WHITE: Color;
    r: number;
    g: number;
    b: number;
    a: number;
    constructor(r?: number, g?: number, b?: number, a?: number);
    setRGB(rgb: number): void;
    copyTo(destObject: any): void;
    clone(): Color;
    getHex(): number;
    toHexString(): string;
    toStyleString(): string;
    parseHexString(str: string): Color;
    static fromHexString(str: string): Color;
}
