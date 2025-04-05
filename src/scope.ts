import type { SourceMap } from "./types"

import postcss from "postcss"
import { getSourceFile } from "./sourcemap"
import selectorParser from "postcss-selector-parser"

export async function attachScopeForStyleSelectors(
    code: string,
    hash: string,
    sourceFile: string,
    map: SourceMap | undefined
) {
    const processor = postcss([
        {
            postcssPlugin: "postcss-attach-scope-qingkuai",
            Rule(rule) {
                const { line, column } = rule.source!.start!
                if (map && getSourceFile(map, line, column) !== sourceFile) {
                    return
                }

                rule.selector = selectorParser(selectors => {
                    selectors.each(selector => {
                        const index = selector.nodes.findLastIndex(({ type }) => {
                            return type === "class" || type === "tag" || type === "id" || type === "universal"
                        })
                        if (index !== -1) {
                            const lastNode = selector.nodes[index]!
                            lastNode.parent?.insertAfter(
                                lastNode,
                                selectorParser.attribute({
                                    attribute: `qk-${hash}`,
                                    value: undefined,
                                    raws: {}
                                })
                            )
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
    return { code: ret.css, mappings: ret.map.toJSON().mappings }
}
