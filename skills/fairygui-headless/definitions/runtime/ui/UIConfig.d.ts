import { Color } from "../math/Color";
export declare class UIConfig {
    static defaultFont: string;
    static windowModalWaiting: string;
    static globalModalWaiting: string;
    static modalLayerColor: Color;
    static buttonSound: string;
    static buttonSoundVolumeScale: number;
    static horizontalScrollBar: string;
    static verticalScrollBar: string;
    static defaultScrollStep: number;
    static defaultScrollDecelerationRate: number;
    static defaultScrollBarDisplay: number;
    static defaultScrollTouchEffect: boolean;
    static defaultScrollBounceEffect: boolean;
    /**
    * 当滚动容器设置为“贴近ITEM”时，判定贴近到哪一个ITEM的滚动距离阀值。
    */
    static defaultScrollSnappingThreshold: number;
    /**
    * 当滚动容器设置为“页面模式”时，判定翻到哪一页的滚动距离阀值。
    */
    static defaultScrollPagingThreshold: number;
    static popupMenu: string;
    static popupMenu_seperator: string;
    static loaderErrorSign: string;
    static tooltipsWin: string;
    static defaultComboBoxVisibleItemCount: number;
    static touchScrollSensitivity: number;
    static touchDragSensitivity: number;
    static clickDragSensitivity: number;
    static bringWindowToFrontOnClick: boolean;
    static frameTimeForAsyncUIConstruction: number;
    static defaultLinkClass: string;
    static scaleLevel: number;
}
