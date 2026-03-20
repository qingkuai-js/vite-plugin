import nodeFs from "node:fs"
import nodePath from "node:path"

export function isUndefined(v: any) {
    return undefined === v
}

export function findFilesByName(dir: string, targetFileName: string, ignoreList: Set<string>) {
    const result: string[] = []
    const entries = nodeFs.readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
        if (ignoreList.has(entry.name)) {
            continue
        }

        const fullPath = nodePath.join(dir, entry.name)
        if (entry.name === targetFileName) {
            result.push(fullPath)
        } else if (entry.isDirectory()) {
            result.push(...findFilesByName(fullPath, targetFileName, ignoreList))
        }
    }
    return result
}
