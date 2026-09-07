import type { SourceMapMappings } from "@jridgewell/sourcemap-codec"

import { decode } from "@jridgewell/sourcemap-codec"
import { SourceMapConsumer } from "source-map-js"

export function offsetSourceMap(
    sourceIndices: number[],
    mappings: string,
    preLine: number,
    preColumn: number
): SourceMapMappings {
    const indices = new Set(sourceIndices)
    return decode(mappings).map(line => {
        return line.map(segment => {
            if (segment.length === 1 || !indices.has(segment[1])) {
                return segment
            }
            if (segment[2] === preLine) {
                segment[3] += preColumn
            } else {
                segment[2] += preLine
            }
            return segment
        })
    })
}

export async function getOriginalPosition(map: any, line: number, column: number) {
    return new SourceMapConsumer(map).originalPositionFor({ line, column })
}
