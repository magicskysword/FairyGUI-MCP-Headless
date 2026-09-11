/**
 * Calculates the visible polygon of a filled image without changing its size.
 *
 * The returned coordinates are in the image's local pixel space. A null result
 * represents an empty fill, while a full fill returns the image rectangle.
 */
export declare function fillImage(width: number, height: number, method: number, origin: number, clockwise: boolean, amount: number): number[] | null;
