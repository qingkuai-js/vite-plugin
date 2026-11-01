import type { Logger, Rollup } from "vite"

import nodeFs from "node:fs"
import nodePath from "node:path"
import qingkuai from "../src/index"

import { build } from "vite"
import { util } from "qingkuai/compiler"
import { afterEach, describe, expect, it } from "vitest"

const { formatSourceCode } = util

const MAIN_FILE = formatSourceCode(`
    import App from "./App.qk"
    import { mountApp } from "qingkuai"

    mountApp(App, "#app")
`)

const warnings: string[] = []
const workspaces: string[] = []

const logger: Logger = {
    hasWarned: false,
    hasErrorLogged: () => false,
    clearScreen() {},
    info() {},
    warn(message) {
        warnings.push(message)
    },
    warnOnce(message) {
        warnings.push(message)
    },
    error() {}
}

afterEach(() => {
    for (const workspace of workspaces.splice(0)) {
        nodeFs.rmSync(workspace, { recursive: true, force: true })
    }
    warnings.length = 0
})

function createProject(files: Record<string, string>) {
    // 放在仓库目录内，保证 "qingkuai" 能从仓库的 node_modules 解析
    // inside the repo so that "qingkuai" resolves from the repository node_modules
    const workspace = nodeFs.mkdtempSync(nodePath.join(process.cwd(), "tests", ".tmp-"))
    workspaces.push(workspace)

    for (const [relative, content] of Object.entries(files)) {
        const filePath = nodePath.join(workspace, relative)
        nodeFs.mkdirSync(nodePath.dirname(filePath), { recursive: true })
        nodeFs.writeFileSync(filePath, content)
    }
    return workspace
}

function collectCode(result: Rollup.RollupOutput | Rollup.RollupOutput[]) {
    const outputs = Array.isArray(result) ? result : [result]
    return outputs
        .flatMap(output => output.output)
        .filter(item => item.type === "chunk")
        .map(item => item.code)
        .join("\n")
}

async function buildProject(files: Record<string, string>) {
    const root = createProject(files)
    const result = await build({
        root,
        configFile: false,
        customLogger: logger,
        plugins: [qingkuai()],
        build: {
            write: false,
            minify: false,
            lib: {
                entry: "src/main.ts",
                formats: ["es"],
                fileName: () => "main.js"
            }
        }
    })
    return collectCode(result as Rollup.RollupOutput | Rollup.RollupOutput[])
}

describe("configuration file in build", () => {
    it("applies whitespace from .qingkuairc", async () => {
        const template = formatSourceCode(`
            <div>
                <span>  a  b  </span>
            </div>
        `)

        const preserved = await buildProject({
            ".qingkuairc": JSON.stringify({ whitespace: "preserve" }),
            "src/main.ts": MAIN_FILE,
            "src/App.qk": template
        })
        expect(preserved).toContain("  a  b  ")

        warnings.length = 0
        const collapsed = await buildProject({
            ".qingkuairc": JSON.stringify({ whitespace: "trim-collapse" }),
            "src/main.ts": MAIN_FILE,
            "src/App.qk": template
        })
        expect(collapsed).not.toContain("  a  b  ")
    })

    it("applies preserveHtmlComments from .qingkuairc", async () => {
        const template = formatSourceCode(`
            <div>
                <!-- HTMLCOMMENTMARK -->
                <span>text</span>
            </div>
        `)

        const always = await buildProject({
            ".qingkuairc": JSON.stringify({ preserveHtmlComments: "always" }),
            "src/main.ts": MAIN_FILE,
            "src/App.qk": template
        })
        expect(always).toContain("HTMLCOMMENTMARK")

        warnings.length = 0
        const never = await buildProject({
            ".qingkuairc": JSON.stringify({ preserveHtmlComments: "never" }),
            "src/main.ts": MAIN_FILE,
            "src/App.qk": template
        })
        expect(never).not.toContain("HTMLCOMMENTMARK")
    })

    it("applies resolveImportExtension from .qingkuairc", async () => {
        const appFile = formatSourceCode(`
            <lang-ts>
                import Hello from "./Hello"
            </lang-ts>

            <div>
                <Hello />
            </div>
        `)
        const files = {
            "src/main.ts": MAIN_FILE,
            "src/App.qk": appFile,
            "src/Hello.qk": "<div>hi</div>"
        }

        const withExtension = await buildProject({
            ...files,
            ".qingkuairc": JSON.stringify({ resolveImportExtension: true })
        })
        expect(withExtension).toContain("hi")

        warnings.length = 0
        await expect(
            buildProject({
                ...files,
                ".qingkuairc": JSON.stringify({ resolveImportExtension: false })
            })
        ).rejects.toThrow()
    })

    it("inherits a parent config and lets a closer one override it", async () => {
        const template = formatSourceCode(`
            <div>
                <span>  a  b  </span>
            </div>
        `)

        const inherited = await buildProject({
            ".qingkuairc": JSON.stringify({ whitespace: "preserve" }),
            "src/main.ts": MAIN_FILE,
            "src/App.qk": template
        })
        expect(inherited).toContain("  a  b  ")

        warnings.length = 0
        const overridden = await buildProject({
            ".qingkuairc": JSON.stringify({ whitespace: "preserve" }),
            "src/.qingkuairc": JSON.stringify({ whitespace: "trim-collapse" }),
            "src/main.ts": MAIN_FILE,
            "src/App.qk": template
        })
        expect(overridden).not.toContain("  a  b  ")
    })

    it("applies configuration inherited through extends", async () => {
        const code = await buildProject({
            ".qingkuairc": JSON.stringify({ extends: "./base.json", whitespace: "preserve" }),
            "base.json": JSON.stringify({
                whitespace: "trim-collapse",
                preserveHtmlComments: "always"
            }),
            "src/main.ts": MAIN_FILE,
            "src/App.qk": formatSourceCode(`
                <div>
                    <!-- HTMLCOMMENTMARK -->
                    <span>  a  b  </span>
                </div>
            `)
        })

        expect(code).toContain("HTMLCOMMENTMARK")
        expect(code).toContain("  a  b  ")
    })

    it("warns about an unparsable config instead of failing silently", async () => {
        const code = await buildProject({
            ".qingkuairc": "{ not json",
            "src/main.ts": MAIN_FILE,
            "src/App.qk": "<div>text</div>"
        })

        expect(code).toContain("text")
        const output = warnings.join("\n")
        expect(output).toContain("Failed to parse configuration file")
        expect(output).toContain(".qingkuairc")
    })

    it("reports a broken config once even when several directories resolve it", async () => {
        const mainFile = formatSourceCode(`
            import App from "./App.qk"
            import Child from "./nested/Child.qk"
            import { mountApp } from "qingkuai"

            mountApp(App, "#app")
            mountApp(Child, "#child")
        `)

        await buildProject({
            ".qingkuairc": "{ not json",
            "src/main.ts": mainFile,
            "src/App.qk": "<div>app</div>",
            "src/nested/Child.qk": "<div>child</div>"
        })

        expect(warnings.filter(item => item.includes("Failed to parse configuration file"))).toHaveLength(1)
    })

    it("warns when the config is not a JSON object", async () => {
        await buildProject({
            ".qingkuairc": "[]",
            "src/main.ts": MAIN_FILE,
            "src/App.qk": "<div>text</div>"
        })

        expect(warnings.join("\n")).toContain("must be a JSON object")
    })
})
