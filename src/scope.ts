import type { PostcssPluginError, SourceMap } from "./types"

import postcss from "postcss"
import { commonMessage } from "qingkuai/compiler"
import selectorParser from "postcss-selector-parser"

export async function attachScopeForStyleSelectors(
    code: string,
    hash: string,
    sourceFile: string,
    map: SourceMap | undefined
) {
    let error: PostcssPluginError | undefined
    const processor = postcss([
        {
            postcssPlugin: "postcss-attach-scope-qingkuai",
            Rule(rule) {
                if (rule.parent && "name" in rule?.parent && rule.parent.name === "keyframes") {
                    return
                }
                rule.selector = selectorParser(selectors => {
                    selectors.each(selector => {
                        const scopePseudoSelectors = selector.nodes.filter(
                            node => node.type === "pseudo" && node.value === ":scope"
                        ) as selectorParser.Pseudo[]
                        if (scopePseudoSelectors.length) {
                            if (scopePseudoSelectors.length > 1) {
                                error = {
                                    loc: scopePseudoSelectors[1].source?.start,
                                    message: commonMessage.DuplicateScopePseudo[1]()
                                }
                            } else {
                                const fistScopePseudo = scopePseudoSelectors[0]
                                if (!fistScopePseudo.nodes[0]?.toString()) {
                                    error = {
                                        loc: fistScopePseudo?.source?.start,
                                        message: commonMessage.NoParameterForScopePseudo[1]()
                                    }
                                }
                                if (fistScopePseudo.nodes.length > 1) {
                                    error = {
                                        loc: fistScopePseudo?.source?.start,
                                        message: commonMessage.TooManyParamaterForScopePseudo[1]()
                                    }
                                }
                                fistScopePseudo.nodes[0] && (selector = fistScopePseudo.nodes[0])
                            }
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
                            lastNode.parent?.insertAfter(
                                lastNode,
                                selectorParser.attribute({
                                    attribute: `qk-${hash}`,
                                    value: undefined,
                                    raws: {}
                                })
                            )
                            scopePseudoSelectors[0]?.replaceWith(...scopePseudoSelectors[0].nodes)
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
