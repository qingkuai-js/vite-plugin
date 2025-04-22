import * as rollup from "rollup"
import dts from "rollup-plugin-dts"
import esbuild from "rollup-plugin-esbuild"

export default rollup.defineConfig(commentLineArgs => {
    const isWatchMode = commentLineArgs.watch
    const inputOptions = {
        external: [
            "vite",
            "postcss",
            "node:fs",
            "node:path",
            "node:crypto",
            "source-map-js",
            "merge-source-map",
            "lines-and-columns",
            "qingkuai/compiler",
            "@ampproject/remapping",
            "postcss-selector-parser",
            "@jridgewell/sourcemap-codec"
        ],
        input: {
            index: "./src/index.ts"
        },
        output: {
            dir: "dist",
            format: "es",
            sourcemap: true
        },
        plugins: [
            esbuild({
                target: "esNext"
            })
        ]
    }

    const result = [
        inputOptions,
        Object.assign({}, inputOptions, {
            output: {
                dir: "dist",
                format: "cjs",
                entryFileNames: "[name].cjs"
            }
        })
    ]
    if (!isWatchMode) {
        result.push({
            input: `./dist/temp-type/index.d.ts`,
            output: {
                format: "es",
                inlineDynamicImports: true,
                file: `dist/index.d.ts`
            },
            plugins: [dts()]
        })
    }

    return result
})
