import type { CompileOptions, CompileResult } from "qingkuai/compiler"
import type { Logger, Plugin, ResolvedConfig, ViteDevServer } from "vite"
import type { ConfigParsingMessage } from "qingkuai-language-service/config"
import type { InitOptions, SourceMap } from "./types"

import * as vite from "vite"

import nodeFs from "node:fs"
import nodeUrl from "node:url"
import nodePath from "node:path"
import nodeCrypto from "node:crypto"

import { isNumber, isUndefined } from "./util"
import { LinesAndColumns } from "lines-and-columns"
import { encode } from "@jridgewell/sourcemap-codec"
import { attachScopeForStyleSelectors } from "./scope"
import { globalStyle, VIRTUAL_STYLE_ID_RE } from "./constants"
import { getOriginalPosition, offsetSourceMap } from "./sourcemap"
import { ReactivityMode, WhitespaceMode, compile, isCompileError } from "qingkuai/compiler"
import { ConfigParsingMessageKind, createConfigResolver } from "qingkuai-language-service/config"

export default function qingkuai(options: InitOptions = {}): Plugin {
    let isDev: boolean
    let sourcemap: boolean
    let cssSourcemap: boolean
    let viteConfig: ResolvedConfig

    const reportedConfigMessages = new Set<string>()
    const compileResultCache = new Map<string, CompileResult>()

    const configResolver = createConfigResolver(
        {
            read: filePath => {
                return nodeFs.readFileSync(filePath, "utf-8")
            },
            exist: filePath => {
                return nodeFs.existsSync(filePath)
            }
        },
        {
            dir: filePath => {
                return nodePath.resolve(nodePath.dirname(filePath))
            },
            resolve: (...segments) => {
                return nodePath.resolve(...segments)
            },
            ext: nodePath.extname,
            base: nodePath.basename,
            relative: nodePath.relative
        }
    )

    if (isUndefined(options.maxScheduleDepth)) {
        options.maxScheduleDepth = 300
    }

    return {
        name: "qingkuai-compiler",

        config(_, env) {
            isDev = env.command === "serve"
            return {
                define: {
                    __qk__dev: isDev,
                    __qk__max_schedule_depth: options.maxScheduleDepth
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
                const qingkuaiConfig = getQingkuaiConfig(importer)
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

            // 生成一个相对路径且不存在的文件名
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
                const tsTransform = transformWithOxc ?? transformWithEsbuild
                const tsCompileRes = await tsTransform(
                    compiledCode,
                    id,
                    {
                        sourcemap,
                        target: "esnext",
                        [transformWithOxc ? "lang" : "loader"]: "ts"
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
                    const location = new LinesAndColumns(src).locationForIndex(err.loc.start.index) || undefined
                    this.error({
                        loc: location && {
                            file: id,
                            line: location.line + 1,
                            column: location.column
                        },
                        message: err.message
                    })
                } else if (err.cause && isNumber(err.cause.pos)) {
                    this.error({ message: err.message })
                } else {
                    this.error(
                        "Qingkuai compile result is invalid. Please report this at https://github.com/qingkuai-js/qingkuai/issues and include your .qk source for reproduction."
                    )
                }
            }
        }
    }

    function getQingkuaiConfig(filePath: string) {
        return configResolver.resolve(filePath, (configPath, message) => {
            reportConfigMessage(viteConfig.logger, configPath, message)
        })
    }

    function reportConfigMessage(logger: Logger, filePath: string, message: ConfigParsingMessage) {
        // 同一份配置会在每个组件目录下各解析一次，按配置文件路径与消息内容去重
        // A config file is resolved once per component directory, so dedupe by path and message
        const key = `${filePath}\0${message.value}`
        if (reportedConfigMessages.has(key)) {
            return
        }
        reportedConfigMessages.add(key)

        const reason =
            message.kind === ConfigParsingMessageKind.Error
                ? "Failed to parse configuration file"
                : "Configuration file"
        logger.warn(`[qingkuai] ${reason} ${filePath}: ${message.value}`)
    }

    function forgetConfigMessages(configPath: string) {
        const prefix = `${configPath}\0`
        for (const key of reportedConfigMessages) {
            if (key.startsWith(prefix)) {
                reportedConfigMessages.delete(key)
            }
        }
    }

    function createQingkuaiConfigurationWatcher(server: ViteDevServer) {
        const watcher = server.watcher
        const handleFileChange = (filePath: string) => {
            for (const configPath of configResolver.removeCacheByPath(filePath)) {
                forgetConfigMessages(configPath)
                configResolver.resolve(configPath, (path, message) => {
                    reportConfigMessage(server.config.logger, path, message)
                })
            }
        }
        watcher.on("change", handleFileChange)
        watcher.on("add", handleFileChange)
        watcher.on("unlink", handleFileChange)
    }

    function getCompileOptions(id: string) {
        const qingkuaiConfig = getQingkuaiConfig(id)
        const ret: CompileOptions = {
            interpretiveComments: isUndefined(qingkuaiConfig.interpretiveComments)
                ? isDev
                : !!qingkuaiConfig.interpretiveComments,
            allowConstReactive: qingkuaiConfig.allowConstReactive !== false,
            requireReactivityMark: qingkuaiConfig.requireReactivityMark === true,
            reactivityMode:
                qingkuaiConfig.reactivityMode === "shallow" ? ReactivityMode.Shallow : ReactivityMode.Reactive
        }
        switch (qingkuaiConfig.whitespace) {
            case "trim": {
                ret.whitespace = WhitespaceMode.Trim
                break
            }
            case "collapse": {
                ret.whitespace = WhitespaceMode.Collapse
                break
            }
            case "preserve": {
                ret.whitespace = WhitespaceMode.Preserve
                break
            }
            default: {
                ret.whitespace = WhitespaceMode.TrimCollapse
                break
            }
        }
        switch (qingkuaiConfig.preserveHtmlComments) {
            case "always": {
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
