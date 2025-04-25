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
    const hashAttribute = selectorParser.attribute({
        attribute: `qk-${hash}`,
        value: undefined,
        raws: {}
    })
    const processor = postcss([
        {
            postcssPlugin: "postcss-attach-scope-qingkuai",
            Rule(rule) {
                if (rule.parent && "name" in rule?.parent && rule.parent.name === "keyframes") {
                    return
                }
                rule.selector = selectorParser(selectors => {
                    selectors.each(selector => {
                        let usedScopeAttribute = false
                        for (let i = 0; i < selector.nodes.length; i++) {
                            const item = selector.nodes[i]
                            if (item.type === "attribute" && item.attribute === "qk-scope") {
                                ;[usedScopeAttribute, selector.nodes[i]] = [true, hashAttribute]
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
                            lastNode.parent?.insertAfter(lastNode, hashAttribute)
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
    return { error, code: ret.css, mappings: ret.map.toJSON().mappings }
}
