#!/usr/bin/env node
import nodeFs from "node:fs"
import nodePath from "node:path"

import { spawnSync } from "node:child_process"

const ROOT = nodePath.resolve(process.cwd())
const PKG_PATH = nodePath.join(ROOT, "package.json")

main()

function readPackageJson() {
    return JSON.parse(nodeFs.readFileSync(PKG_PATH, "utf-8"))
}

function writePackageJson(pkg) {
    nodeFs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n", "utf-8")
}

function bumpVersion(version) {
    const parts = version.split(".").map(Number)
    if (parts.length !== 3 || parts.some(n => Number.isNaN(n) || n < 0)) {
        throw new Error(`Unsupported version format: ${version}`)
    }
    parts[2] += 1
    return parts.join(".")
}

async function run(command, args, opts = {}) {
    const result = spawnSync(command, args, { stdio: "inherit", ...opts })
    if (result.error) {
        throw result.error
    }
    if (result.status !== 0) {
        throw new Error(`Command failed: ${command} ${args.join(" ")}`)
    }
    return result
}

function verifyCleanWorkingTree() {
    const result = spawnSync("git", ["status", "--porcelain"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "inherit"]
    })
    if (result.error) {
        throw result.error
    }
    if (result.status !== 0) {
        throw new Error("Failed to check git working tree status")
    }
    if (result.stdout.trim()) {
        throw new Error(
            "Git working tree is not clean. Please commit or stash your changes before releasing."
        )
    }
}

async function release() {
    verifyCleanWorkingTree()
    const pkg = readPackageJson()
    const currentVersion = pkg.version
    if (!currentVersion) {
        throw new Error("package.json is missing version")
    }

    const arg = process.argv[2]
    const newVersion = arg ? arg.replace(/^v/, "") : bumpVersion(currentVersion)
    const tag = `v${newVersion}`

    if (newVersion === currentVersion) {
        console.log(`Version unchanged: ${newVersion}`)
        return
    }

    pkg.version = newVersion
    writePackageJson(pkg)

    await run("git", ["add", "package.json"])
    await run("git", ["commit", "-m", `release: bump version to ${tag}`])
    await run("git", ["tag", tag])
    await run("git", ["push"])
    await run("git", ["push", "origin", tag])

    console.log(`Released ${tag}`)
}

async function main() {
    try {
        await release()
    } catch (error) {
        console.error(error instanceof Error ? error.message : error)
        process.exit(1)
    }
}
