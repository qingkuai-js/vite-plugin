import type { CompileResult } from "qingkuai/compiler"
import type { QingkuaiConfiguration, SourceMap } from "./types"
import type { PluginOption, ResolvedConfig, ViteDevServer } from "vite"

import { findFilesByName } from "./util"
import { randomBytes } from "node:crypto"
import { offsetSourceMap } from "./sourcemap"
import { compile, util } from "qingkuai/compiler"
import { existsSync, readFileSync } from "node:fs"
import { encode } from "@jridgewell/sourcemap-codec"
import { attachScopeForStyleSelectors } from "./scope"
import { transformWithEsbuild, preprocessCSS } from "vite"
import { basename, dirname, extname, join as pathJoin } from "node:path"

export default function qingkuaiPlugin(): PluginOption {
    let isDev: boolean
    let sourcemap: boolean
    let cssSourcemap: boolean
    let viteConfig: ResolvedConfig

    const parseFailedConfigFiles: string[] = []
    const compileResultCache = new Map<string, CompileResult>()
    const qingkuaiConfigurations = new Map<string, QingkuaiConfiguration>()

    const qingkuaiPackageServeRE = /node_modules\/\.vite\/deps\/chunk-.*$/
    const confIdentifierRE = /__qk_expose_(?:dependencies|destructions)__/g
    const styleIdRE = /^virtual:\[\d+\].*?\.qk.(?:css|s[ac]ss|less|stylus|postcss)\?\d{13}$/
    const qingkuaiPackageBuildRE = /(?:node_modules)?\/qingkuai\/dist\/esm\/(?:chunks|runtime)\/\w+\.js$/

    return {
        name: "qingkuai-compiler",

        config(_, env) {
            isDev = env.command === "serve"
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

        resolveId(id, importer) {
            if (styleIdRE.test(id)) {
                return id
            }
            if (importer?.endsWith(".qk") && !extname(id)) {
                const qingkuaiConfig = getQingkuaiConfiguration(id)
                return pathJoin(dirname(importer), id + (qingkuaiConfig.resolveImportExtension ? ".qk" : ""))
            }
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
            const qingkuaiConfig = getQingkuaiConfiguration(id)
            if (!id.endsWith(".qk")) {
                if (qingkuaiPackageServeRE.test(id) || qingkuaiPackageBuildRE.test(id)) {
                    const ret = src.replace(confIdentifierRE, s => {
                        switch (s) {
                            case "__qk_expose_dependencies__":
                                return JSON.stringify(!!qingkuaiConfig.exposeDependencies)
                            case "__qk_expose_destructions__":
                                return JSON.stringify(!!qingkuaiConfig.exposeDestructions)
                            default:
                                return s
                        }
                    })
                    return ret
                }
                return
            }

            const compileRes = compile(src, {
                sourcemap,
                debug: isDev,
                hashId: compileResultCache.get(id)?.hashId || undefined,
                reserveTemplateComment: getReserveHtmlComments(qingkuaiConfig),
                componentName: util.kebab2Camel(basename(id, extname(id)), true)
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
            const dir = dirname(id)
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
        watcher.on("unlink", path => qingkuaiConfigurations.delete(dirname(path)))
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
            qingkuaiConfigurations.set(dirname(fileName), JSON.parse(readFileSync(fileName, "utf-8")))
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
