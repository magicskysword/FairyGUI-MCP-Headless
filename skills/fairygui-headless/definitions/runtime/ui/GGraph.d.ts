import { GObject } from "./GObject";
import { ByteBuffer } from "../utils/ByteBuffer";
import { Shape } from "../core/Shape";
import { UIElement } from "../core/UIElement";
export declare class GGraph extends GObject {
    protected _element: Shape;
    constructor();
    protected createElement(): void;
    get color(): number;
    set color(value: number);
    get element(): Shape;
    replaceMe(target: GObject): void;
    setNativeObject(obj: UIElement): void;
    getProp(index: number): any;
    setProp(index: number, value: any): void;
    setup_beforeAdd(buffer: ByteBuffer, beginPos: number): void;
}
