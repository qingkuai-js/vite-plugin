export function isNull(v: any): v is null {
    return null === v
}

export function isNumber(v: any): v is number {
    return typeof v === "number"
}

export function isUndefined(v: any): v is undefined {
    return undefined === v
}
