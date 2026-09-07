import type { Plugin, ResolvedConfig, ViteDevServer } from "vite"
import type { CompileOptions, CompileResult } from "qingkuai/compiler"
import type { InitOptions, QingkuaiConfiguration, SourceMap } from "./types"

import * as vite from "vite"

import nodeFs from "node:fs"
import nodeUrl from "node:url"
import nodePath from "node:path"
import nodeCrypto from "node:crypto"

import { LinesAndColumns } from "lines-and-columns"
import { encode } from "@jridgewell/sourcemap-codec"
import { attachScopeForStyleSelectors } from "./scope"
import { compile, isCompileError } from "qingkuai/compiler"
import { globalStyle, VIRTUAL_STYLE_ID_RE } from "./constants"
import { findFilesByName, isNumber, isUndefined } from "./util"
import { getOriginalPosition, offsetSourceMap } from "./sourcemap"

export default function qingkuai(options: InitOptions = {}): Plugin {
    let isDev: boolean
    let sourcemap: boolean
    let cssSourcemap: boolean
    let viteConfig: ResolvedConfig

    const parseFailedConfigFiles: string[] = []
    const compileResultCache = new Map<string, CompileResult>()
    const qingkuaiConfigurations = new Map<string, QingkuaiConfiguration>()

    if (isUndefined(options.maxScheduleDepth)) {
        options.maxScheduleDepth = 300
    }

    return {
        name: "qingkuai-compiler",

        config(_, env) {
            isDev = env.command === "serve"
            return {
                define: {
                    __qk_max_schedule_depth: options.maxScheduleDepth
                }
            }
        },

        configureServer(server) {
            createQingkuaiConfigurationWatcher(server)
        },

        configResolved(config) {
            viteConfig = config

            if (isDev) {
                sourcemap = true
                cssSourcemap = !!config.css.devSourcemap
            } else {
                cssSourcemap = true
                sourcemap = config.build.sourcemap !== false
            }

            loadAllQingkuaiConfigurations(config.root)
        },

        transformIndexHtml(html) {
            return {
                html,
                tags: [
                    {
                        tag: "style",
                        injectTo: "head",
                        children: globalStyle
                    }
                ]
            }
        },

        resolveId(id, importer) {
            if (VIRTUAL_STYLE_ID_RE.test(id)) {
                return id
            }
            if (importer?.endsWith(".qk") && !nodePath.extname(id)) {
                const qingkuaiConfig = getQingkuaiConfiguration(id)
                return nodePath.join(
                    nodePath.dirname(importer),
                    id + (qingkuaiConfig.resolveImportExtension ? ".qk" : "")
                )
            }
            return id
        },

        async load(id) {
            if (!VIRTUAL_STYLE_ID_RE.test(id)) {
                return
            }

            const { fileId, index } = parseStyleId(id)
            if (index === -1) {
                return ""
            }

            let virtualFileName: string
            const compileRes = compileResultCache.get(fileId)!
            const styleDescriptor = compileRes.styleDescriptors[index]

            // create a relative and not existing file name
            while (true) {
                const hash = nodeCrypto.randomBytes(6).toString("hex")
                virtualFileName = `${fileId}.${hash}.${styleDescriptor.lang}`

                if (!nodeFs.existsSync(virtualFileName)) {
                    break
                }
            }

            let preprocessRes: Awaited<ReturnType<typeof vite.preprocessCSS>>
            try {
                preprocessRes = await vite.preprocessCSS(styleDescriptor.code, virtualFileName, {
                    ...viteConfig,
                    css: {
                        ...viteConfig.css,
                        postcss: {
                            from: virtualFileName
                        }
                    }
                })
            } catch (err: any) {
                let errorPos: number | null = null
                const lac = new LinesAndColumns(styleDescriptor.code)
                switch (styleDescriptor.lang) {
                    case "css":
                    case "less":
                    case "stylus": {
                        delete err.loc
                        err.message += `\n\nCaused by: "${fileId}".`
                        break
                    }
                    case "sass":
                    case "scss": {
                        if (err.sassMessage) {
                            err.message = err.sassMessage
                        }
                        if (isNumber(err.line) && isNumber(err.column)) {
                            errorPos = lac.indexForLocation({
                                line: err.line - 1,
                                column: err.column - 1
                            })
                        }
                        break
                    }
                }
                if (isNumber(errorPos) && !isNaN(errorPos)) {
                    const loc = lac.locationForIndex(errorPos + styleDescriptor.loc.start.index)
                    if (loc) {
                        err.loc = {
                            file: fileId,
                            line: loc.line + 1,
                            column: loc.column
                        }
                        delete err.frame
                    }
                }
                return this.error(err)
            }
            preprocessRes.deps?.forEach(dep => this.addWatchFile(dep))

            if (!cssSourcemap || styleDescriptor.global) {
                return preprocessRes
            }

            const phantomIndices: number[] = []
            const assertedPreprocessMap = preprocessRes.map as SourceMap | undefined
            const attachScopeResult = await attachScopeForStyleSelectors(
                preprocessRes.code,
                compileRes.hashId,
                virtualFileName,
                assertedPreprocessMap
            )
            const attachScopeMap = attachScopeResult.map ?? assertedPreprocessMap

            // sourcemap 的 sources 存在多种形态：预处理产物为绝对路径，postcss
            // 会将其重塑为相对路径（基准可能是 process.cwd() 或虚拟文件所在
            // 目录），还可能出现 file:// 形式——统一解析为绝对路径后再与虚拟
            // 文件名比较，找出所有需要替换回真实 .qk 路径的幻影条目
            //
            // The sourcemap's sources come in multiple forms: the preprocessing
            // result uses absolute paths, postcss re-bases them into relative
            // paths (based on process.cwd() or the virtual file's directory),
            // and file:// forms may also appear — resolve everything to
            // absolute paths before comparing with the virtual file name to
            // find every phantom entry that must be replaced with the real .qk
            // path
            const sameVirtualSource = (source: string) => {
                let resolved = source.startsWith("file://") ? nodeUrl.fileURLToPath(source) : source
                if (!nodePath.isAbsolute(resolved)) {
                    const candidates = [
                        nodePath.resolve(nodePath.dirname(virtualFileName), resolved),
                        nodePath.resolve(resolved)
                    ]
                    return candidates.some(
                        candidate => nodePath.normalize(candidate) === nodePath.normalize(virtualFileName)
                    )
                }
                return nodePath.normalize(resolved) === nodePath.normalize(virtualFileName)
            }

            attachScopeMap?.sources.forEach((source, index) => {
                if (sameVirtualSource(source)) {
                    phantomIndices.push(index)
                }
            })

            const offsetMappings = encode(
                offsetSourceMap(
                    phantomIndices,
                    attachScopeResult.mappings,
                    styleDescriptor.loc.start.line - 1,
                    styleDescriptor.loc.start.column - 1
                )
            )
            if (attachScopeResult.error) {
                if (!attachScopeResult.error.loc) {
                    this.error(attachScopeResult.error.message)
                } else {
                    const preprocessedPosition = await getOriginalPosition(
                        assertedPreprocessMap,
                        attachScopeResult.error.loc.line,
                        attachScopeResult.error.loc.column
                    )
                    if (preprocessedPosition.source && !sameVirtualSource(preprocessedPosition.source)) {
                        this.error({
                            message: attachScopeResult.error.message,
                            loc: {
                                file: preprocessedPosition.source,
                                line: preprocessedPosition.line,
                                column: preprocessedPosition.column
                            }
                        })
                    }
                    const preprocessedIndex =
                        new LinesAndColumns(styleDescriptor.code).indexForLocation({
                            line: preprocessedPosition.line - 1,
                            column: preprocessedPosition.column
                        }) || 0
                    const position = compileRes.positions[styleDescriptor.loc.start.index + preprocessedIndex]
                    this.error({
                        message: attachScopeResult.error.message,
                        loc: {
                            file: fileId,
                            line: position.line,
                            column: position.column
                        }
                    })
                }
            }
            return {
                code: attachScopeResult.code,
                map: {
                    version: 3,
                    mappings: offsetMappings,
                    names: attachScopeMap?.names || assertedPreprocessMap?.names || [],
                    sources: attachScopeMap?.sources.map((source, index) => {
                        return phantomIndices.includes(index) ? fileId : source
                    }) ?? [
                        ...(assertedPreprocessMap?.sources.filter(source => {
                            return !sameVirtualSource(source)
                        }) ?? []),
                        fileId
                    ],
                    sourcesContent: attachScopeMap?.sourcesContent?.map((content, index) => {
                        return phantomIndices.includes(index) ? nodeFs.readFileSync(fileId, "utf-8") : content
                    })
                }
            }
        },

        async transform(src, id) {
            if (!id.endsWith(".qk")) {
                return
            }

            try {
                const compileRes = compile(src, {
                    ...getCompileOptions(id),
                    sourcemap,
                    debug: isDev,
                    hashId: compileResultCache.get(id)?.hashId
                })
                compileRes.messages.forEach(({ type, value: warning }) => {
                    if (type === "warning") {
                        this.warn(warning.message)
                    }
                })
                compileResultCache.set(id, compileRes)

                const compiledCodeArr = [compileRes.code]
                compileRes.styleDescriptors.forEach((_, index) => {
                    compiledCodeArr.push(`import "virtual:[${index}]${id}.css?${Date.now()}"`)
                })

                const baseMap: any = {
                    version: 3,
                    sources: [id],
                    sourcesContent: [src]
                }
                const compiledCode = compiledCodeArr.join("\n")
                if (!compileRes.scriptDescriptor.isTS) {
                    if (!sourcemap) {
                        return compiledCode
                    }
                    return {
                        code: compiledCode,
                        map: Object.assign(baseMap, {
                            mappings: compileRes.mappings
                        })
                    }
                }

                const transformWithOxc = (vite as any).transformWithOxc
                const transformWithEsbuild = (vite as any).transformWithEsbuild
                const tsCompileRes = await (transformWithOxc ?? transformWithEsbuild)(
                    compiledCode,
                    id,
                    {
                        sourcemap,
                        lang: "ts",
                        loader: "ts",
                        target: "esnext"
                    },
                    sourcemap
                        ? {
                              version: 3,
                              names: [],
                              sources: [id],
                              sourcesContent: [src],
                              mappings: compileRes.mappings
                          }
                        : undefined
                )

                if (!tsCompileRes) {
                    this.error("Current Vite runtime does not provide TypeScript transform APIs.")
                }

                if (!sourcemap) {
                    return tsCompileRes.code
                }

                let transformedMap = tsCompileRes.map
                if (typeof tsCompileRes.map === "string") {
                    transformedMap = JSON.parse(tsCompileRes.map)
                }
                return {
                    code: tsCompileRes.code,
                    map: Object.assign(baseMap, {
                        mappings: transformedMap?.mappings || compileRes.mappings
                    })
                }
            } catch (err: any) {
                if (isCompileError(err)) {
                    this.error(err.message, err.loc.start.index)
                } else if (err.cause && isNumber(err.cause.pos)) {
                    this.error(err, err.cause.pos)
                } else {
                    this.error(
                        "Qingkuai compile result is invalid. Please report this at https://github.com/qingkuai-js/qingkuai/issues and include your .qk source for reproduction."
                    )
                }
            }
        }
    }

    function getQingkuaiConfiguration(id: string) {
        let config: QingkuaiConfiguration = {
            interpretiveComments: true,
            resolveImportExtension: true,
            preserveHtmlComments: "development"
        }
        while (true) {
            const dir = nodePath.dirname(id)
            if (dir === id) {
                break
            }

            const got = qingkuaiConfigurations.get((id = dir))
            if (got) {
                config = got
                break
            }
        }
        return config
    }

    function createQingkuaiConfigurationWatcher(server: ViteDevServer) {
        const watcher = server.watcher
        const isQingkuaiConfig = (filePath: string) => {
            return (
                nodePath.basename(filePath) === ".qingkuairc" &&
                !filePath.includes(`${nodePath.sep}node_modules${nodePath.sep}`)
            )
        }

        watcher.on("unlink", filePath => {
            if (isQingkuaiConfig(filePath)) {
                qingkuaiConfigurations.delete(nodePath.dirname(filePath))
            }
        })
        watcher.on("change", filePath => {
            if (isQingkuaiConfig(filePath)) {
                recordQingkuaiConfiguration(filePath)
            }
        })
        watcher.on("add", filePath => {
            if (isQingkuaiConfig(filePath)) {
                recordQingkuaiConfiguration(filePath)
            }
        })
    }

    function loadAllQingkuaiConfigurations(workspaceDir: string) {
        findFilesByName(workspaceDir, ".qingkuairc", new Set(["node_modules"])).forEach(fileName => {
            recordQingkuaiConfiguration(fileName)
        })
    }

    function recordQingkuaiConfiguration(fileName: string) {
        try {
            qingkuaiConfigurations.set(nodePath.dirname(fileName), JSON.parse(nodeFs.readFileSync(fileName, "utf-8")))
        } catch {
            parseFailedConfigFiles.push(fileName)
        }
    }

    function getCompileOptions(id: string) {
        const qingkuaiConfig = getQingkuaiConfiguration(id)
        const ret: CompileOptions = {
            interpretiveComments: isUndefined(qingkuaiConfig.interpretiveComments)
                ? isDev
                : !!qingkuaiConfig.interpretiveComments,
            shorthandDerivedDeclaration: isUndefined(qingkuaiConfig.shorthandDerivedDeclaration)
                ? true
                : !!qingkuaiConfig.shorthandDerivedDeclaration,
            reactivityMode: qingkuaiConfig.reactivityMode === "shallow" ? "shallow" : "reactive"
        }
        switch (qingkuaiConfig.whitespace) {
            case "trim":
            case "collapse":
            case "preserve":
            case "trim-collapse": {
                ret.whitespace = qingkuaiConfig.whitespace
                break
            }
            default: {
                ret.whitespace = "trim-collapse"
                break
            }
        }
        switch (qingkuaiConfig.preserveHtmlComments) {
            case "all": {
                ret.preserveHtmlComments = true
                break
            }
            case "never": {
                ret.preserveHtmlComments = false
                break
            }
            case "production": {
                ret.preserveHtmlComments = !isDev
                break
            }
            default: {
                ret.preserveHtmlComments = isDev
                break
            }
        }
        return ret
    }
}

function parseStyleId(id: string) {
    const m1 = /^virtual:\[(\d+)\]/.exec(id)!
    const m2 = /\.[a-z]+\?\d{13}$/.exec(id)!
    if (!m1 || !m2) {
        return {
            index: -1,
            fileId: ""
        }
    }

    return {
        index: parseInt(m1[1]),
        fileId: id.slice(m1.index + m1[0].length, m2.index)
    }
}
