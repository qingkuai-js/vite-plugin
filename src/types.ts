export interface SourceMap {
    version: number
    file?: string
    names: string[]
    mappings: string
    sources: string[]
    sourceRoot?: string
    sourcesContent?: string[]
    x_google_ignoreList?: number[]
}

export interface PostcssPluginError {
    message: string
    loc?: {
        line: number
        column: number
    }
}

export interface PackageManifest {
    version?: string
    [key: string]: unknown
}

export type InitOptions = Partial<{
    maxScheduleDepth: number
}>
