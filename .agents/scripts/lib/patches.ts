// The changes that passed `npm run verify`, recorded by patch rather than by tree, so the push
// check can let a branch through when it holds the same changes on a newer default branch: a
// rebase that only moved the base. Without this, every rebase of a verified branch, and of every
// branch of a stack, would need verify again before it could push.

import { join } from 'node:path'
import { git } from './git.ts'
import { readJson, stateDir, writeJson } from './state.ts'

/** A branch's changes that passed verify, and where the branch left the default branch then. */
export type PassedPatch = { patchId: string; base: string; at: string }

/** Enough for every branch of a long stack, and a few rebases of each. */
const MAX_RECORDED = 50

function patchesPath(root: string): string {
    return join(stateDir(root), 'verified-patches.json')
}

export function readPassedPatches(root: string): PassedPatch[] {
    return readJson<{ patches?: PassedPatch[] }>(patchesPath(root))?.patches ?? []
}

/**
 * An id for everything a commit changes since `base`, the same wherever the changes sit: git's
 * patch id ignores line numbers and file order, but not the three lines around each change, which
 * the diff sets itself whatever `diff.context` says. So a rebase that changed nothing near the
 * branch's changes keeps the id, and one that did, by a conflict or by new code next to them,
 * doesn't. `--verbatim` keeps whitespace, which the default strips, so a change inside a string or
 * to formatting changes the id. Binary files count by their full blob ids. A git older than 2.39
 * has no `--verbatim`, so every rebase there needs verify again.
 */
export function branchPatchId(root: string, base: string, commit: string): string | undefined {
    const diff = git(root, [
        'diff',
        '--unified=3',
        '--diff-algorithm=myers',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        '--full-index',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        base,
        commit,
    ])
    if (!diff.ok || !diff.stdout.trim()) return undefined
    const id = git(root, ['patch-id', '--verbatim'], { input: diff.stdout })
    return id.ok ? id.stdout.split(' ')[0] || undefined : undefined
}

/**
 * Records that the changes `commit` makes since `base` passed verify. Best effort: a record that
 * can't be written only means the next rebase needs verify again.
 */
export function recordPassedPatch(root: string, base: string, commit: string): void {
    try {
        const patchId = branchPatchId(root, base, commit)
        if (patchId === undefined) return
        const others = readPassedPatches(root).filter(
            (patch) => patch.patchId !== patchId || patch.base !== base,
        )
        const patches = [...others, { patchId, base, at: new Date().toISOString() }]
        writeJson(patchesPath(root), { patches: patches.slice(-MAX_RECORDED) })
    } catch {
        // Nothing to undo: the push or the verify run it follows already succeeded.
    }
}

/**
 * Forgets that the changes `commit` makes since `base` passed, whatever base they passed on: verify
 * is about to check them again, and a run that doesn't pass must not leave them counted as passed.
 */
export function forgetPassedPatch(root: string, base: string, commit: string): void {
    try {
        const patchId = branchPatchId(root, base, commit)
        const patches = readPassedPatches(root)
        if (patchId === undefined || !patches.some((patch) => patch.patchId === patchId)) return
        writeJson(patchesPath(root), {
            patches: patches.filter((patch) => patch.patchId !== patchId),
        })
    } catch {
        // A record that can't be read or written exempts nothing either.
    }
}

/**
 * Whether `commit` holds changes that passed verify, from `base` or from an earlier point of the
 * default branch that `base` has moved on from.
 */
export function hasPassedPatch(root: string, base: string, commit: string): boolean {
    const patches = readPassedPatches(root)
    if (patches.length === 0) return false
    const patchId = branchPatchId(root, base, commit)
    if (patchId === undefined) return false
    return patches.some(
        (patch) =>
            patch.patchId === patchId &&
            git(root, ['merge-base', '--is-ancestor', patch.base, base]).ok,
    )
}
