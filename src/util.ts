import { join } from "node:path"
import { readdirSync } from "node:fs"

export function findFilesByName(dir: string, targetFileName: string, ignoreList: Set<string>) {
    const result: string[] = []
    const entries = readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
        if (ignoreList.has(entry.name)) {
            continue
        }

        const fullPath = join(dir, entry.name)
        if (entry.name === targetFileName) {
            result.push(fullPath)
        } else if (entry.isDirectory()) {
            result.push(...findFilesByName(fullPath, targetFileName, ignoreList))
        }
    }
    return result
}
