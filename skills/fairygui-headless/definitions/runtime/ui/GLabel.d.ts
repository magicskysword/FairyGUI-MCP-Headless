import { GComponent } from "./GComponent";
import { GObject } from "./GObject";
import { GTextField } from "./GTextField";
import { GTextInput } from "./GTextInput";
import { ByteBuffer } from "../utils/ByteBuffer";
export declare class GLabel extends GComponent {
    protected _titleObject: GObject;
    protected _iconObject: GObject;
    constructor();
    get icon(): string;
    set icon(value: string);
    get title(): string;
    set title(value: string);
    get text(): string;
    set text(value: string);
    get titleColor(): number;
    set titleColor(value: number);
    get titleFontSize(): number;
    set titleFontSize(value: number);
    get color(): number;
    set color(value: number);
    set editable(val: boolean);
    get editable(): boolean;
    getTextField(): GTextField | GTextInput;
    getProp(index: number): any;
    setProp(index: number, value: any): void;
    protected constructExtension(buffer: ByteBuffer): void;
    setup_afterAdd(buffer: ByteBuffer, beginPos: number): void;
}
