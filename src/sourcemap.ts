import type { SourceMap } from "./types"
import type { SourceMapMappings } from "@jridgewell/sourcemap-codec"

import { SourceMapConsumer } from "source-map-js"
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

export function getSourceFile(sourcemap: SourceMap, line: number, column: number) {
    const consumer = new SourceMapConsumer({
        ...sourcemap,
        version: sourcemap.version.toString()
    })

    return consumer.originalPositionFor({
        line: line,
        column: column
    }).source
}
