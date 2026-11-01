import type { PackageManifest } from "../src/types"

import nodeFs from "node:fs"
import nodePath from "node:path"

import { spawnSync } from "node:child_process"

const ROOT = nodePath.resolve(process.cwd())
const PKG_PATH = nodePath.join(ROOT, "package.json")

function readPackageJson(): PackageManifest {
    return JSON.parse(nodeFs.readFileSync(PKG_PATH, "utf-8")) as PackageManifest
}

function writePackageJson(pkg: PackageManifest): void {
    nodeFs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n", "utf-8")
}

function bumpVersion(version: string): string {
    const parts = version.split(".").map(Number)
    if (parts.length !== 3 || parts.some(n => Number.isNaN(n) || n < 0)) {
        throw new Error(`Unsupported version format: ${version}`)
    }
    parts[2] += 1
    return parts.join(".")
}

function run(command: string, args: string[]): void {
    const result = spawnSync(command, args, { stdio: "inherit" })
    if (result.error) {
        throw result.error
    }
    if (result.status !== 0) {
        throw new Error(`Command failed: ${command} ${args.join(" ")}`)
    }
}

function verifyCleanWorkingTree(): void {
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
        throw new Error("Git working tree is not clean. Commit or stash your changes before releasing.")
    }
}

function release(): void {
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

    run("git", ["add", "package.json"])
    run("git", ["commit", "-m", `release: bump version to ${tag}`])
    run("git", ["tag", tag])
    run("git", ["push"])
    run("git", ["push", "origin", tag])

    console.log(`Released ${tag}`)
}

function main(): void {
    try {
        release()
    } catch (error) {
        console.error(error instanceof Error ? error.message : error)
        process.exit(1)
    }
}

main()
