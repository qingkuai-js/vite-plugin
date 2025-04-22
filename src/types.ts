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
    exposeDestructions: boolean
    exposeDependencies: boolean
    insertTipComments: boolean
    resolveImportExtension: boolean
    convenientDerivedDeclaration: boolean
    reserveHtmlComments: "all" | "never" | "development" | "production"
}>

export interface PostcssPluginError {
    message: string
    loc?: {
        line: number
        column: number
    }
}
