import type { CompileOptions, CompileResult } from "qingkuai/compiler"
import type { QingkuaiConfiguration, SourceMap } from "./types"
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite"

import * as vite from "vite"

import nodePath from "node:path"
import nodeCrypto from "node:crypto"

import { globalStyle } from "./constants"
import { compile } from "qingkuai/compiler"
import { existsSync, readFileSync } from "node:fs"
import { LinesAndColumns } from "lines-and-columns"
import { encode } from "@jridgewell/sourcemap-codec"
import { findFilesByName, isUndefined } from "./util"
import { attachScopeForStyleSelectors } from "./scope"
import { getOriginalPosition, offsetSourceMap } from "./sourcemap"

export default function qingkuai(): Plugin {
    let isDev: boolean
    let sourcemap: boolean
    let cssSourcemap: boolean
    let viteConfig: ResolvedConfig

    const parseFailedConfigFiles: string[] = []
    const compileResultCache = new Map<string, CompileResult>()
    const qingkuaiConfigurations = new Map<string, QingkuaiConfiguration>()
    const styleIdRE = /^virtual:\[\d+\].*?\.qk.(?:css|s[ac]ss|less|stylus|postcss)\?\d{13}$/

    return {
        name: "qingkuai-compiler",

        config(_, env) {
            isDev = env.command === "serve"

            // const rootPath = path.resolve(process.cwd(), config.root ?? "")
            // const qingkuaiConfig = getQingkuaiConfiguration(rootPath)
            // return {
            //     define: {
            //         __qk_expose_dependencies__: JSON.stringify(!!qingkuaiConfig.exposeDependencies),
            //         __qk_expose_destructions__: JSON.stringify(!!qingkuaiConfig.exposeDestructions)
            //     }
            // }
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
            if (styleIdRE.test(id)) {
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
            if (styleIdRE.test(id)) {
                const { fileId, index } = parseStyleId(id)
                if (index === -1) {
                    return ""
                }

                let virtualFileName: string
                const compileRes = compileResultCache.get(fileId)!
                const style = compileRes.styleDescriptors[index]

                // create a relative and not existing file name
                while (true) {
                    const hash = nodeCrypto.randomBytes(6).toString("hex")
                    virtualFileName = `${fileId}.${hash}.${style.lang}`
                    if (!existsSync(virtualFileName)) {
                        break
                    }
                }

                const preprocessRes = await vite.preprocessCSS(style.code, virtualFileName, {
                    ...viteConfig,
                    css: {
                        ...viteConfig.css,
                        postcss: {
                            from: virtualFileName
                        }
                    }
                })
                if (!cssSourcemap) {
                    return preprocessRes.code
                }

                const assertedPreprocessMap = preprocessRes.map as SourceMap | undefined
                const attachScopeResult = await attachScopeForStyleSelectors(
                    preprocessRes.code,
                    compileRes.hashId,
                    virtualFileName,
                    assertedPreprocessMap
                )
                const offsetMappings = encode(
                    offsetSourceMap(
                        attachScopeResult.mappings,
                        preprocessRes.deps?.size || 0,
                        style.loc.start.line - 1,
                        style.loc.start.column - 1
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
                        const preprocessedIndex =
                            new LinesAndColumns(style.code).indexForLocation({
                                line: preprocessedPosition.line - 1,
                                column: preprocessedPosition.column
                            }) || 0
                        const position = compileRes.positions[style.loc.start.index + preprocessedIndex]
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
                        names: assertedPreprocessMap?.names || [],
                        sources: [...(assertedPreprocessMap ? assertedPreprocessMap.sources.slice(0, -1) : []), fileId]
                    }
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

                const inputMap = sourcemap
                    ? {
                          version: 3,
                          sources: [id],
                          sourcesContent: [src],
                          mappings: compileRes.mappings
                      }
                    : undefined
                const transformWithEsbuild = (vite as any).transformWithEsbuild
                const transformWithOxc = (vite as any).transformWithOxc
                const tsCompileRes = transformWithEsbuild
                    ? await transformWithEsbuild(
                          compiledCode,
                          id,
                          {
                              sourcemap,
                              loader: "ts",
                              target: "esnext"
                          },
                          inputMap
                      )
                    : transformWithOxc
                      ? await transformWithOxc(
                            compiledCode,
                            id,
                            {
                                sourcemap,
                                target: "esnext"
                            },
                            inputMap
                        )
                      : null

                if (!tsCompileRes) {
                    this.error("Current Vite runtime does not provide TypeScript transform APIs.")
                }

                if (!sourcemap) {
                    return tsCompileRes.code
                }
                const transformedMap =
                    typeof tsCompileRes.map === "string" ? JSON.parse(tsCompileRes.map) : tsCompileRes.map
                return {
                    code: tsCompileRes.code,
                    map: Object.assign(baseMap, {
                        mappings: transformedMap?.mappings || compileRes.mappings
                    })
                }
            } catch (err: any) {
                if (err.loc.start && "index" in err.loc.start) {
                    ;((err.pos = err.loc.start.index), this.error(err))
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
            qingkuaiConfigurations.set(nodePath.dirname(fileName), JSON.parse(readFileSync(fileName, "utf-8")))
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
