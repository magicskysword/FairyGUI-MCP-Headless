/**
 * <code>Vec2</code> 对象表示二维坐标系统中的某个位置，其中 x 表示水平轴，y 表示垂直轴。
 */
export declare class Vec3 {
    /**该点的水平坐标。*/
    x: number;
    /**该点的垂直坐标。*/
    y: number;
    z: number;
    /**
     * 根据指定坐标，创建一个新的 <code>Vec2</code> 对象。
     * @param x	（可选）水平坐标。
     * @param y	（可选）垂直坐标。
     */
    constructor(x?: number, y?: number, z?: number);
    /**
     * 将 <code>Vec2</code> 的成员设置为指定值。
     * @param	x 水平坐标。
     * @param	y 垂直坐标。
     * @return 当前 Vec2 对象。
     */
    set(x: number, y: number, z: number): Vec3;
    /**
     * 重置
     */
    reset(): Vec3;
    /**返回包含 x 和 y 坐标的值的字符串。*/
    toString(): string;
    add(v: Vec3): void;
    sub(v: Vec3): void;
    cross(v: Vec3): void;
    multiplyScalar(scalar: number): void;
    normalize(): void;
    copy(v: Vec3): void;
    equals(another: Vec3): boolean;
}
