import type { SourceMap } from "./types"

import fs from "fs-extra"
import path from "node:path"

export function generateSourceMapFiles(generate: string, map: SourceMap) {
    const sourcemapPath = path.resolve(__dirname, "../sourcemap-test")
    const gpath = path.resolve(sourcemapPath, "./g.css")
    const mpath = path.resolve(sourcemapPath, "./s.css.map")
    fs.removeSync(gpath)
    fs.removeSync(mpath)
    fs.writeFileSync(gpath, generate, "utf-8")
    fs.writeFileSync(
        mpath,
        JSON.stringify({
            version: 3,
            names: map.names,
            sources: map.sources,
            mappings: map.mappings,
            sourcesContent: map.sourcesContent
        }),
        "utf-8"
    )
}
