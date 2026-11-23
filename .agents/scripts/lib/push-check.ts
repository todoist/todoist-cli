// The push check. Before an agent runs a shell command, it stops one that pushes code from this
// checkout that `npm run verify` hasn't passed, or opens a pull request for it. A push sends
// commits, not the working tree, so what's pushed has to be exactly a tree verify passed. Changes
// that verify records nothing for (docs, files only CI reads) need no verify.

import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { branchBase, defaultBranchRef, findRepoRoot, git } from './git.ts'
import { findTargets } from './push-targets.ts'
import { readVerified } from './state.ts'
import {
    changedSince,
    changeNeedsChecks,
    codeFingerprint,
    commitChanges,
    needsChecks,
    snapshot,
    snapshotCommit,
} from './tree.ts'

export type PushVerdict =
    | { decision: 'allow'; notes: string[] }
    | { decision: 'deny'; reason: string; notes: string[] }

type Context = {
    root: string
    notes: string[]
    head: string | undefined
    verified: string | undefined
    defaultRef: string | undefined
    /** The working tree's fingerprint, read once per command however many sources it pushes. */
    tree: () => string
}

/**
 * What one push source sends: `ok`, `unclear` (every branch, or a wildcard), `unverified`, `dirty`
 * (unverified, and the working tree holds more than the pushed commit) or `other` (unverified, and
 * not what's checked out).
 */
type SourceResult = 'ok' | 'unclear' | 'unverified' | 'dirty' | 'other'

export function checkCommand({
    root,
    command,
    cwd,
}: {
    /** The checkout to guard. Pushes from any other folder are that folder's business. */
    root: string
    command: string
    /** The folder the command starts in. */
    cwd: string
}): PushVerdict {
    const notes: string[] = []
    const targets = findTargets(command, cwd)
    if (!targets.some((target) => target.kind !== 'commit')) return { decision: 'allow', notes }

    const realRoot = realpathSync(root)
    let tree: string | undefined
    const context: Context = {
        root,
        notes,
        head: resolveCommit(root, 'HEAD'),
        verified: readVerified(root)?.fingerprint,
        defaultRef: defaultBranchRef(root),
        tree: () => (tree ??= codeFingerprint(snapshot(root))),
    }
    let committedFirst = false
    let unclear = false
    let unverified = false
    let dirty = false
    let otherBranch = false
    let onlyPullRequests = true
    for (const target of targets) {
        if (target.dir === null) {
            if (target.kind !== 'commit') {
                notes.push(`can't tell which folder a ${target.kind} runs in, so it isn't checked`)
            }
            continue
        }
        const checkout = checkoutOf(target.dir)
        // A folder that doesn't exist yet, such as one the same command makes.
        if (checkout === undefined && target.kind !== 'commit') {
            notes.push(
                `can't find the checkout of ${target.dir}, so a ${target.kind} there isn't checked`,
            )
        }
        if (checkout !== realRoot) continue
        if (target.kind === 'commit') {
            committedFirst = true
            continue
        }
        // With no refspec, git's push settings can send other branches than HEAD.
        const sources =
            target.implicit && configuredPush(root, target.remote ?? null) ? ['*'] : target.sources
        for (const source of sources) {
            const result = checkSource(context, source, target.kind, committedFirst)
            if (result === 'ok') continue
            if (target.kind === 'push') onlyPullRequests = false
            if (result === 'unclear') unclear = true
            else {
                unverified = true
                if (result === 'dirty') dirty = true
                if (result === 'other') otherBranch = true
            }
        }
    }
    if (!unclear && !unverified) return { decision: 'allow', notes }
    return {
        decision: 'deny',
        reason: denyReason({ unclear, unverified, dirty, otherBranch, onlyPullRequests }),
        notes,
    }
}

/**
 * The checkout to guard: the one the agent works in, when it's another worktree of this repository
 * with the push check, such as one Claude Code entered mid-session; otherwise `root`. Never another
 * repository, whose code the hook must not run under this project's trust.
 */
export function checkoutToGuard(root: string, cwd: string | undefined): string {
    const other = cwd ? checkoutOf(cwd) : undefined
    if (other === undefined || other === realpathSync(root)) return root
    const shared = commonDir(other)
    if (shared === undefined || shared !== commonDir(root)) return root
    return existsSync(join(other, '.agents/scripts/guard.ts')) ? other : root
}

/** The real path of the checkout a folder is in, or undefined when it isn't in one. */
function checkoutOf(dir: string): string | undefined {
    const toplevel = findRepoRoot(dir)
    return toplevel === undefined ? undefined : realPath(toplevel)
}

/** The repository a checkout belongs to, the same for all its worktrees. */
function commonDir(dir: string): string | undefined {
    const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    return common.ok ? realPath(common.stdout.trim()) : undefined
}

function realPath(path: string): string | undefined {
    try {
        return realpathSync(path)
    } catch {
        return undefined
    }
}

function setting(root: string, key: string): string | undefined {
    const value = git(root, ['config', '--get', key])
    return value.ok ? value.stdout.trim() || undefined : undefined
}

/**
 * Whether a push with no refspec sends what git's settings pick rather than the current branch:
 * the push refspec or mirror setting of the remote it pushes to, or `push.default=matching`.
 */
function configuredPush(root: string, remote: string | null): boolean {
    if (setting(root, 'push.default') === 'matching') return true
    const current = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    const branch = current.ok ? current.stdout.trim() : undefined
    const target =
        remote ??
        (branch ? setting(root, `branch.${branch}.pushRemote`) : undefined) ??
        setting(root, 'remote.pushDefault') ??
        (branch ? setting(root, `branch.${branch}.remote`) : undefined) ??
        soleRemote(root) ??
        'origin'
    const mirror = git(root, ['config', '--type=bool', '--get', `remote.${target}.mirror`])
    return setting(root, `remote.${target}.push`) !== undefined || mirror.stdout.trim() === 'true'
}

/** The only remote, which git pushes to when nothing else names one. */
function soleRemote(root: string): string | undefined {
    const remotes = git(root, ['remote']).stdout.split('\n').filter(Boolean)
    return remotes.length === 1 ? remotes[0] : undefined
}

function resolveCommit(root: string, ref: string): string | undefined {
    const commit = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    return commit.ok ? commit.stdout.trim() || undefined : undefined
}

function checkSource(
    context: Context,
    source: string,
    kind: 'push' | 'pr' | 'commit',
    committedFirst: boolean,
): SourceResult {
    if (source.includes('*')) return 'unclear'

    const { root, notes, head } = context
    let commit = resolveCommit(root, source)
    if (commit === undefined) {
        if (kind === 'pr') {
            notes.push(`can't find ${source}, so the pull request isn't checked`)
            return 'ok'
        }
        // A source that isn't a commit yet, such as a branch the same command makes, is HEAD's.
        commit = head
        if (commit === undefined) return 'ok'
    }
    // The same command commits first, so what it pushes is the working tree.
    const fromTree = committedFirst && commit === head
    const fingerprint = fromTree ? context.tree() : codeFingerprint(snapshotCommit(root, commit))
    if (fingerprint === context.verified) return 'ok'
    if (onlyUncheckedChanges(context, fromTree ? undefined : commit)) return 'ok'

    if (!fromTree && commit !== head) return 'other'
    if (!fromTree && context.tree() !== fingerprint) return 'dirty'
    return 'unverified'
}

/**
 * Whether everything a commit, or the working tree when `commit` is undefined, changes since the
 * default branch is something verify records nothing for: docs, or files only CI reads. Verify
 * checks the whole tree, and records a pass, when there is no default branch to compare with, so
 * then nothing is exempt.
 */
function onlyUncheckedChanges(context: Context, commit: string | undefined): boolean {
    const { root, defaultRef } = context
    // From the pushed commit: the branch checked out may have left main somewhere else.
    const base = branchBase(root, defaultRef, commit ?? 'HEAD')
    if (base === undefined) return false
    if (commit === undefined)
        return !changedSince(root, base).some((path) => needsChecks(root, path))
    return !commitChanges(root, base, commit).some(({ path, deleted }) =>
        changeNeedsChecks(path, deleted),
    )
}

function denyReason({
    unclear,
    unverified,
    dirty,
    otherBranch,
    onlyPullRequests,
}: {
    unclear: boolean
    unverified: boolean
    dirty: boolean
    otherBranch: boolean
    onlyPullRequests: boolean
}): string {
    const lines: string[] = []
    if (unclear) {
        lines.push(
            "This pushes every branch at once, the ones a wildcard matches, or what git's push " +
                'settings pick (`remote.<name>.push`, or `push.default=matching`), so the push ' +
                "check can't tell what it sends. Name each branch instead: `git push origin <branch>`.",
        )
    }
    if (unverified) {
        if (lines.length > 0) lines.push('')
        lines.push(
            onlyPullRequests
                ? "This opens a pull request for code that `npm run verify` hasn't passed."
                : "This pushes code that `npm run verify` hasn't passed.",
            '',
            otherBranch
                ? 'Verify checks the working tree and keeps one record per checkout, so it can only ' +
                      'vouch for what you have checked out. Check out each branch, run `npm run ' +
                      'verify` there, and push it on its own.'
                : 'Run `npm run verify` and fix what fails, then run this command again.',
        )
        if (dirty) {
            lines.push(
                "Verify checks the working tree, which holds changes your last commit doesn't. " +
                    'Commit what belongs in it, and stash the rest with `git stash -u` before you ' +
                    'run verify. `git stash pop` brings them back afterwards.',
            )
        }
    }
    lines.push(
        'If it has to be pushed this way anyway, ask the person you are working with to push it ' +
            'themselves.',
        'Details: docs/agents.md',
    )
    return lines.join('\n')
}
