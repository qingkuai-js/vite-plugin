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

export type QingkuaiConfiguration = Partial<{
    interpretiveComments: boolean
    resolveImportExtension: boolean
    shorthandDerivedDeclaration: boolean
    reactivityMode: "reactive" | "shallow"
    whitespace: "preserve" | "trim" | "collapse" | "trim-collapse"
    preserveHtmlComments: "all" | "never" | "development" | "production"
}>

export interface PostcssPluginError {
    message: string
    loc?: {
        line: number
        column: number
    }
}
