import { UIElement } from "./UIElement";
import { EventDispatcher } from "../event/EventDispatcher";
import { Vec2 } from "../math/Vec2";
import { TextField } from "./TextField";
import { InputTextField } from "./InputTextField";
import { Shape } from "./Shape";
import { Image } from "./Image";
import { MovieClip } from "./MovieClip";
import { IStage } from "./IStage";
export declare class Stage extends UIElement implements IStage {
    private _window;
    private _touchscreen;
    private _electron;
    private _pointers;
    private _touchTarget;
    private _pointerPos;
    private _touchCount;
    private _rollOverChain;
    private _rollOutChain;
    private _lastPointerId;
    private _nextCursor;
    private _focused;
    private _nextFocus;
    private _focusOutChain;
    private _focusInChain;
    private _focusHistory;
    static get anyInput(): boolean;
    constructor();
    setWindow(ownerWindow: Window): void;
    get window(): Window;
    get pointerPos(): Vec2;
    get touchScreen(): boolean;
    get touchTarget(): UIElement;
    get touchCount(): number;
    getPointerPos(pointerId?: number, ret?: Vec2): Vec2;
    addPointerMonitor(pointerId: number, target: EventDispatcher): void;
    removePointerMonitor(target: EventDispatcher): void;
    cancelClick(pointerId: number): void;
    private onKeydown;
    private onKeyup;
    private setLastInput;
    private handlePointer;
    private clickTest;
    private handleWheel;
    private handleContextMenu;
    private getPointer;
    private handleRollOver;
    private setLastPointer;
    onClickLink(event: Event, href: string): void;
    get focusedElement(): UIElement;
    validateFocus(container: UIElement, child: UIElement): void;
    setFocus(newFocus: UIElement, byKey?: boolean): void;
    private onFocusRemoving;
    private checkNextFocus;
    private onWindowBlur;
}
export interface CustomTags {
    "fgui-div": UIElement;
    "fgui-img": Image;
    "fgui-movieclip": MovieClip;
    "fgui-text": TextField;
    "fgui-input": InputTextField;
    "fgui-shape": Shape;
    "fgui-stage": Stage;
}
declare global {
    export function createUIElement<K extends keyof CustomTags>(tagName: K, owner?: any): CustomTags[K];
}
