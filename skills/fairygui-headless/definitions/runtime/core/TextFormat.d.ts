import { Vec2 } from "../math/Vec2";
import { AlignType, VertAlignType } from "../ui/FieldTypes";
export declare class TextFormat {
    size: number;
    font: string;
    color: number;
    lineSpacing: number;
    letterSpacing: number;
    bold: boolean;
    underline: boolean;
    italic: boolean;
    strikethrough: boolean;
    align: AlignType;
    verticalAlign: VertAlignType;
    outline: number;
    outlineColor: number;
    shadowOffset: Vec2;
    shadowColor: number;
    copy(source: TextFormat): void;
}
