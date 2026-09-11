import { UIElement } from "./UIElement";
import { Color } from "../math/Color";
export declare class Shape extends UIElement {
    protected _color: number;
    protected _type: number;
    constructor();
    init(): void;
    get color(): number;
    set color(value: number);
    drawRect(lineWidth: number, lineColor: Color, fillColor: Color): void;
    drawRoundRect(lineWidth: number, lineColor: Color, fillColor: Color, topLeftRadius: number, topRightRadius: number, bottomLeftRadius: number, bottomRightRadius: number): void;
    drawEllipse(lineWidth: number, lineColor: Color, fillColor: Color, startDegree?: number, endDegree?: number): void;
    drawPolygon(points: Array<number>, fillColor: Color, lineWidth?: number, lineColor?: Color): void;
    drawRegularPolygon(sides: number, lineWidth: number, centerColor: Color, lineColor: Color, fillColor: Color, rotation: number, distances: Array<number>): void;
    clear(): void;
    setType(type: number): void;
    protected onSizeChanged(): void;
}
