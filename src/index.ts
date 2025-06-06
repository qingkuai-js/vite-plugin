import type { CompileResult } from "qingkuai/compiler"
import type { QingkuaiConfiguration, SourceMap } from "./types"
import type { PluginOption, ResolvedConfig, ViteDevServer } from "vite"

import path from "node:path"
import { findFilesByName } from "./util"
import { randomBytes } from "node:crypto"
import { compile, util } from "qingkuai/compiler"
import { existsSync, readFileSync } from "node:fs"
import { LinesAndColumns } from "lines-and-columns"
import { encode } from "@jridgewell/sourcemap-codec"
import { attachScopeForStyleSelectors } from "./scope"
import { transformWithEsbuild, preprocessCSS, optimizeDeps } from "vite"
import { getOriginalPosition, offsetSourceMap } from "./sourcemap"

export default function qingkuai(): PluginOption {
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

        config(config, env) {
            const rootPath = path.resolve(process.cwd(), config.root ?? "")
            const qingkuaiConfig = getQingkuaiConfiguration(rootPath)
            isDev = env.command === "serve"
            return {
                define: {
                    __qk_expose_dependencies__: JSON.stringify(!!qingkuaiConfig.exposeDependencies),
                    __qk_expose_destructions__: JSON.stringify(!!qingkuaiConfig.exposeDestructions)
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

            const optimizeDeps = config.optimizeDeps
            if (!optimizeDeps) {
                Object.assign(config, {
                    optimizeDeps: {
                        exclude: ["qingkuai"]
                    }
                })
            } else if (!optimizeDeps.exclude) {
                optimizeDeps.exclude = ["qingkuai"]
            } else {
                optimizeDeps.exclude.push("qingkuai")
            }

            loadAllQingkuaiConfigurations(config.root)
        },

        resolveId(id, importer) {
            if (styleIdRE.test(id)) {
                return id
            }
            if (importer?.endsWith(".qk") && !path.extname(id)) {
                const qingkuaiConfig = getQingkuaiConfiguration(id)
                return path.join(path.dirname(importer), id + (qingkuaiConfig.resolveImportExtension ? ".qk" : ""))
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
                const style = compileRes.inputDescriptor.styles[index]

                // create a relative and not existing file name
                while (true) {
                    const hash = randomBytes(6).toString("hex")
                    virtualFileName = `${fileId}.${hash}.${style.lang}`
                    if (!existsSync(virtualFileName)) {
                        break
                    }
                }

                const preprocessRes = await preprocessCSS(style.code, virtualFileName, {
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
                        const position = compileRes.inputDescriptor.positions[style.loc.start.index + preprocessedIndex]
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
                    sourcemap,
                    debug: isDev,
                    hashId: compileResultCache.get(id)?.hashId || undefined,
                    componentName: util.kebab2Camel(path.basename(id, path.extname(id)), true),
                    reserveTemplateComment: getReserveHtmlComments(getQingkuaiConfiguration(id))
                })
                compileRes.messages.forEach(({ type, value: warning }) => {
                    if (type === "warning") {
                        this.warn(warning.message)
                    }
                })
                compileResultCache.set(id, compileRes)

                const compiledCodeArr = [compileRes.code]
                compileRes.inputDescriptor.styles.forEach((_, index) => {
                    compiledCodeArr.push(`import "virtual:[${index}]${id}.css?${Date.now()}"`)
                })

                const baseMap: any = {
                    version: 3,
                    sources: [id],
                    sourcesContent: [src]
                }
                const compiledCode = compiledCodeArr.join("\n")
                if (!compileRes.inputDescriptor.script.isTS) {
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

                const esBuildCompileRes = await transformWithEsbuild(
                    compiledCode,
                    id,
                    {
                        sourcemap,
                        loader: "ts",
                        target: "esnext"
                    },
                    sourcemap
                        ? {
                              version: 3,
                              sources: [id],
                              sourcesContent: [src],
                              mappings: compileRes.mappings
                          }
                        : undefined
                )

                if (!sourcemap) {
                    return esBuildCompileRes.code
                }
                return {
                    code: esBuildCompileRes.code,
                    map: Object.assign(baseMap, {
                        mappings: esBuildCompileRes.map.mappings
                    })
                }
            } catch (err: any) {
                ;(err.pos = err.loc.start.index), this.error(err)
            }
        }
    }

    function getQingkuaiConfiguration(id: string) {
        let config: QingkuaiConfiguration = {
            insertTipComments: true,
            exposeDestructions: isDev,
            exposeDependencies: isDev,
            resolveImportExtension: true,
            reserveHtmlComments: "development"
        }
        while (true) {
            const dir = path.dirname(id)
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

    function getReserveHtmlComments(config: QingkuaiConfiguration) {
        switch (config.reserveHtmlComments) {
            case "all":
                return true
            case "never":
                return false
            case "production":
                return !isDev
            default:
                return isDev
        }
    }

    function createQingkuaiConfigurationWatcher(server: ViteDevServer) {
        const watcher = server.watcher.add([".qingkuairc", "!**/node_modules/**"])
        watcher.on("unlink", p => qingkuaiConfigurations.delete(path.dirname(p)))
        watcher.on("change", recordQingkuaiConfiguration)
        watcher.on("add", recordQingkuaiConfiguration)
    }

    function loadAllQingkuaiConfigurations(workspaceDir: string) {
        findFilesByName(workspaceDir, ".qingkuairc", new Set(["node_modules"])).forEach(fileName => {
            recordQingkuaiConfiguration(fileName)
        })
    }

    function recordQingkuaiConfiguration(fileName: string) {
        try {
            qingkuaiConfigurations.set(path.dirname(fileName), JSON.parse(readFileSync(fileName, "utf-8")))
        } catch {
            parseFailedConfigFiles.push(fileName)
        }
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
