import type { PostcssPluginError, SourceMap } from "./types"

import postcss from "postcss"
import selectorParser from "postcss-selector-parser"

export async function attachScopeForStyleSelectors(
    code: string,
    hash: string,
    sourceFile: string,
    map: SourceMap | undefined
) {
    let error: PostcssPluginError | undefined
    const processedRules = new WeakSet<object>()

    const createHashAttribute = () => {
        return selectorParser.attribute({
            attribute: `qk-${hash}`,
            value: undefined,
            raws: {}
        })
    }

    const processor = postcss([
        {
            postcssPlugin: "postcss-attach-scope-qingkuai",
            Rule(rule) {
                if (processedRules.has(rule)) {
                    return
                }
                processedRules.add(rule)

                if (rule.parent && "name" in rule?.parent && rule.parent.name === "keyframes") {
                    return
                }
                rule.selector = selectorParser(selectors => {
                    selectors.each(selector => {
                        let usedScopeAttribute = false
                        for (let i = 0; i < selector.nodes.length; i++) {
                            const item = selector.nodes[i]
                            if (item.type === "attribute" && item.attribute === "qk-scope") {
                                selector.nodes[i] = createHashAttribute()
                                usedScopeAttribute = true
                            }
                        }
                        if (usedScopeAttribute) {
                            return
                        }

                        const index = selector.nodes.findLastIndex(({ type }) => {
                            return (
                                type === "id" ||
                                type === "tag" ||
                                type === "class" ||
                                type === "universal" ||
                                type === "attribute"
                            )
                        })
                        if (index !== -1) {
                            const lastNode = selector.nodes[index]
                            lastNode.parent?.insertAfter(lastNode, createHashAttribute())
                        }
                    })
                }).processSync(rule.selector)
            }
        }
    ])

    const ret = await processor.process(code, {
        from: sourceFile,
        map: {
            prev: map,
            annotation: false
        }
    })
    const outputMap = ret.map?.toJSON()
    return {
        error,
        code: ret.css,
        map: outputMap,
        mappings: outputMap?.mappings || ""
    }
}
