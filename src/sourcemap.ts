import type { SourceMapMappings } from "@jridgewell/sourcemap-codec"

import { decode } from "@jridgewell/sourcemap-codec"

export function offsetSourceMap(
    mappings: string,
    sourceIndex: number,
    preLine: number,
    preColumn: number
): SourceMapMappings {
    return decode(mappings).map(line => {
        return line.map(segment => {
            if (segment.length === 1 || segment[1] !== sourceIndex) {
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
