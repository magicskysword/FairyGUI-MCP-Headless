import { Pool } from "../utils/Pool";
import { EventDispatcher } from "./EventDispatcher";
import { GObject } from "../ui/GObject";
export type EventType = "pointer_down" | "pointer_up" | "pointer_move" | "click" | "right_click" | "roll_over" | "roll_out" | "mouse_wheel" | "key_down" | "key_up" | "added_to_stage" | "removed_from_stage" | "pos_changed" | "size_changed" | "status_changed" | "changed" | "focus_in" | "focus_out" | "drag_start" | "drag_move" | "drag_end" | "drop" | "scroll" | "scroll_end" | "pull_down_release" | "pull_up_release" | "click_item" | "click_link" | "play_end" | "gear_stop";
export interface InputInfo {
    x: number;
    y: number;
    mouseWheelDelta: number;
    pointerId: number;
    button: number;
    clickCount: number;
    holdTime: number;
    shiftKey: boolean;
    altKey: boolean;
    ctrlKey: boolean;
    commandKey: boolean;
    ctrlOrCmdKey: boolean;
    isDblClick: boolean;
    isRightButton: boolean;
    keyCode: string;
    key: string;
}
export declare const lastInput: InputInfo;
export declare class Event {
    data: any;
    constructor();
    get type(): string;
    get target(): EventDispatcher;
    get sender(): GObject;
    get initiator(): HTMLElement;
    get input(): Readonly<InputInfo>;
    stopPropagation(): void;
    preventDefault(): void;
    capturePointer(): void;
    get isDefaultPrevented(): boolean;
}
export declare var EventPool: Pool<Event>;
