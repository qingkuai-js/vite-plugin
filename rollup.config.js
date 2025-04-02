import * as rollup from "rollup"
import esbuild from "rollup-plugin-esbuild"

export default rollup.defineConfig(() => {
    const inputOptions = {
        external: [
            "vite",
            "postcss",
            "node:path",
            "merge-source-map",
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

    return [
        inputOptions,
        Object.assign({}, inputOptions, {
            output: {
                dir: "dist",
                format: "cjs",
                entryFileNames: "[name].cjs"
            }
        })
    ]
})
