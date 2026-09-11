import { GObject } from "./GObject";
import { GRoot } from "./GRoot";
export declare class DragDropManager {
    private _agent;
    private _sourceData;
    static get inst(): DragDropManager;
    constructor();
    get dragAgent(): GObject;
    get dragging(): boolean;
    startDrag(groot: GRoot, icon: string, sourceData?: any, pointerId?: number): void;
    cancel(): void;
    private __dragEnd;
}
