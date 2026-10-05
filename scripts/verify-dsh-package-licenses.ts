/**
 * Enforce upstream MIT declarations and explicit RainyAgent license-file declarations.
 * @module scripts/verify-dsh-package-licenses
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DSH_PACKAGE_NAME = /^@deepseek-ai\/dsh(?:-|$)/
const RAINY_PACKAGES = new Map([
  ['package.json', '@deepseek-ai/dsh-root'],
  ['apps/rainy-desktop/package.json', '@deepseek-ai/dsh-rainy-desktop'],
  ['packages/client/ui-rainy/package.json', '@deepseek-ai/dsh-client-ui-rainy'],
])

/** Result of checking every DSH package reachable through the root workspace list. */
export interface DshPackageLicenseReport {
  /** Number of DSH package manifests checked. */
  packageCount: number
  /** Repository-relative diagnostics for incorrect or missing license declarations. */
  failures: string[]
}

function readManifest(root: string, file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(resolve(root, file), 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`verify-dsh-package-licenses: ${file} must contain a JSON object.`)
  }
  return parsed as Record<string, unknown>
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string')
}

function workspaceManifestPaths(root: string): string[] {
  const rootManifest = readManifest(root, 'package.json')
  const workspaces = rootManifest.workspaces
  if (!isStringArray(workspaces)) {
    throw new Error('verify-dsh-package-licenses: package.json workspaces must be a string array.')
  }

  const files = new Set(['package.json'])
  for (const pattern of workspaces) {
    for (const file of globSync(`${pattern}/package.json`, { cwd: root })) {
      files.add(file)
    }
  }
  return [...files].sort()
}

function printable(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value)
}

/**
 * Check every DSH npm package declared by the repository workspace.
 * @param root - absolute repository root containing the workspace package.json.
 * @returns the checked package count and every non-MIT declaration.
 */
export function inspectDshPackageLicenses(root: string): DshPackageLicenseReport {
  let packageCount = 0
  const failures: string[] = []

  for (const file of workspaceManifestPaths(root)) {
    const manifest = readManifest(root, file)
    const name = manifest.name
    if (typeof name !== 'string' || !DSH_PACKAGE_NAME.test(name)) continue

    packageCount++
    const normalizedFile = file.split(sep).join('/')
    const expected = RAINY_PACKAGES.get(normalizedFile) === name ? 'SEE LICENSE IN LICENSE' : 'MIT'
    if (manifest.license !== expected) {
      failures.push(
        `${normalizedFile}: ${name} must declare "license": "${expected}"; found ${printable(manifest.license)}.`,
      )
    } else if (expected === 'SEE LICENSE IN LICENSE' && !existsSync(resolve(root, dirname(file), 'LICENSE'))) {
      failures.push(`${normalizedFile}: ${name} references a missing package LICENSE file.`)
    }
  }

  return { packageCount, failures }
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  const report = inspectDshPackageLicenses(ROOT)
  if (report.failures.length > 0) {
    process.stderr.write('verify-dsh-package-licenses: invalid DSH package license declarations found:\n')
    for (const failure of report.failures) process.stderr.write(`  ${failure}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(
      `verify-dsh-package-licenses: ${String(report.packageCount)} DSH package(s) checked; license declarations match their owners.\n`,
    )
  }
}
