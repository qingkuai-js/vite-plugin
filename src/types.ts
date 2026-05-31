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

export type InitOptions = Partial<{
    maxScheduleDepth: number
}>

export type QingkuaiConfiguration = Partial<{
    maxScheduleDepth: number
    interpretiveComments: boolean
    resolveImportExtension: boolean
    shorthandDerivedDeclaration: boolean
    reactivityMode: "reactive" | "shallow"
    whitespace: "preserve" | "trim" | "collapse" | "trim-collapse"
    preserveHtmlComments: "all" | "never" | "development" | "production"
}>
