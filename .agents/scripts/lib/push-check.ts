// The push check. Before an agent runs a shell command, it stops one that pushes code from this
// checkout, or another worktree of it, that `npm run verify` hasn't passed, or opens a pull request
// for it. A push sends commits, not the working tree, so what's pushed has to be exactly a tree
// verify passed, or the same changes as one on a newer default branch, as after a rebase. Changes
// that verify records nothing for (docs, files only CI reads) need no verify.

import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { branchBase, defaultBranchRef, findRepoRoot, git, resolveCommit } from './git.ts'
import { hasPassedPatch, recordPassedPatch } from './patches.ts'
import { findTargets } from './push-targets.ts'
import { readVerified } from './state.ts'
import {
    changedSince,
    changeNeedsChecks,
    codeFingerprint,
    commitChanges,
    commitFingerprint,
    needsChecks,
    snapshot,
} from './tree.ts'

export type PushVerdict =
    | { decision: 'allow'; notes: string[] }
    | { decision: 'deny'; reason: string; notes: string[] }

/** One checkout the command pushes from, with what the command does there before it pushes. */
type Checkout = {
    root: string
    notes: string[]
    head: string | undefined
    verified: string | undefined
    /** Read only when needed, since most checks never get that far. */
    defaultRef: () => string | undefined
    /** The working tree's fingerprint, read once however many sources the command pushes. */
    tree: () => string
    committedFirst: boolean
    movedFirst: boolean
    /** Branches the command makes from what's checked out before it pushes them. */
    created: Set<string>
}

/**
 * What one push source sends: `ok`; `every` (every branch, a wildcard, or what git's settings or
 * `xargs` pick); `unknown` (a branch named by a variable, or one that doesn't exist); `moved` (what's
 * checked out changes first); `unverified`; `dirty` (unverified, and the working tree holds more than
 * the pushed commit); or `other` (unverified, and not what's checked out).
 */
type SourceResult = 'ok' | 'every' | 'unknown' | 'moved' | 'unverified' | 'dirty' | 'other'

export function checkCommand({
    root,
    command,
    cwd,
}: {
    /**
     * The checkout the guard lives in. It also guards the other worktrees of its repository that
     * have the guard; pushes from anywhere else are that folder's business.
     */
    root: string
    command: string
    /** The folder the command starts in. */
    cwd: string
}): PushVerdict {
    const notes: string[] = []
    const targets = findTargets(command, cwd)
    if (!targets.some((target) => target.kind === 'push' || target.kind === 'pr')) {
        return { decision: 'allow', notes }
    }

    const guarded = guardedCheckouts(root)
    const checkouts = new Map<string, Checkout>()
    const found = new Set<SourceResult>()
    let onlyPullRequests = true
    for (const target of targets) {
        const pushes = target.kind === 'push' || target.kind === 'pr'
        const what = target.kind === 'pr' ? 'pull request' : 'push'
        if (target.dir === null) {
            if (pushes) notes.push(`can't tell which folder a ${what} runs in, so it isn't checked`)
            continue
        }
        const path = checkoutOf(target.dir)
        // A folder that doesn't exist yet, such as one the same command makes.
        if (path === undefined) {
            if (pushes) {
                notes.push(
                    `can't find the checkout of ${target.dir}, so a ${what} there isn't checked`,
                )
            }
            continue
        }
        if (!guarded(path)) continue
        let checkout = checkouts.get(path)
        if (checkout === undefined) {
            checkout = openCheckout(path, notes)
            checkouts.set(path, checkout)
        }
        if (target.kind === 'commit') checkout.committedFirst = true
        else if (target.kind === 'move') checkout.movedFirst = true
        else if (target.kind === 'create') {
            for (const name of target.sources) checkout.created.add(name)
        } else {
            // With no refspec, git's push settings can send other branches than HEAD.
            const sources =
                target.implicit && configuredPush(path, target.remote ?? null)
                    ? ['*']
                    : target.sources
            for (const source of sources) {
                const result = checkSource(checkout, source, target.kind)
                if (result === 'ok') continue
                if (target.kind === 'push') onlyPullRequests = false
                found.add(result)
            }
        }
    }
    if (found.size === 0) return { decision: 'allow', notes }
    return { decision: 'deny', reason: denyReason(found, onlyPullRequests), notes }
}

/**
 * Which checkouts to guard: the one the guard lives in, and the other worktrees of its repository
 * that have the guard (a worktree on an older branch doesn't), such as one Claude Code entered
 * mid-session. Never another repository.
 */
function guardedCheckouts(root: string): (path: string) => boolean {
    const own = realPath(root)
    let shared: string | undefined
    return (path) => {
        if (path === own) return true
        shared ??= commonDir(root)
        return (
            shared !== undefined &&
            commonDir(path) === shared &&
            existsSync(join(path, '.agents/scripts/guard.ts'))
        )
    }
}

function openCheckout(root: string, notes: string[]): Checkout {
    let tree: string | undefined
    let defaultRef: { ref: string | undefined } | undefined
    return {
        root,
        notes,
        head: resolveCommit(root, 'HEAD'),
        verified: readVerified(root)?.fingerprint,
        defaultRef: () => (defaultRef ??= { ref: defaultBranchRef(root) }).ref,
        tree: () => (tree ??= codeFingerprint(snapshot(root))),
        committedFirst: false,
        movedFirst: false,
        created: new Set(),
    }
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

function checkSource(checkout: Checkout, source: string, kind: 'push' | 'pr'): SourceResult {
    if (source.includes('*')) return 'every'
    // HEAD, or the branch a rebase or pull moves, holds something else by the time the push runs.
    if (checkout.movedFirst) return 'moved'
    // A shell variable or command substitution, whose value the command doesn't show
    if (source.includes('$')) return 'unknown'

    const { root, notes, head } = checkout
    let commit = resolveCommit(root, source)
    if (commit === undefined) {
        if (checkout.created.has(source)) commit = head
        else if (kind === 'pr') {
            // It may exist only on the remote, which no local check can vouch for either way.
            notes.push(`can't find ${source}, so the pull request isn't checked`)
            return 'ok'
        } else return 'unknown'
        if (commit === undefined) return 'ok'
    }
    // The same command commits first, so what it pushes is the working tree.
    const fromTree = checkout.committedFirst && commit === head
    const fingerprint = fromTree ? checkout.tree() : commitFingerprint(root, commit)
    // From the pushed commit: the branch checked out may have left main somewhere else.
    const base = branchBase(root, checkout.defaultRef(), fromTree ? 'HEAD' : commit)
    if (fingerprint === checkout.verified) {
        // So the same changes can push again after a rebase without verifying again. A commit the
        // same command makes doesn't exist yet; its next push records it.
        if (base !== undefined && !fromTree) recordPassedPatch(root, base, commit)
        return 'ok'
    }
    if (onlyUncheckedChanges(root, base, fromTree ? undefined : commit)) return 'ok'
    if (base !== undefined && !fromTree && hasPassedPatch(root, base, commit)) {
        notes.push(`${source} holds changes that already passed verify, so it isn't verified again`)
        return 'ok'
    }

    if (!fromTree && commit !== head) return 'other'
    if (!fromTree && checkout.tree() !== fingerprint) return 'dirty'
    return 'unverified'
}

/**
 * Whether everything a commit, or the working tree when `commit` is undefined, changes since the
 * default branch is something verify records nothing for: docs, or files only CI reads. Verify
 * checks the whole tree, and records a pass, when there is no default branch to compare with, so
 * then nothing is exempt.
 */
function onlyUncheckedChanges(
    root: string,
    base: string | undefined,
    commit: string | undefined,
): boolean {
    if (base === undefined) return false
    if (commit === undefined)
        return !changedSince(root, base).some((path) => needsChecks(root, path))
    return !commitChanges(root, base, commit).some(({ path, deleted }) =>
        changeNeedsChecks(path, deleted),
    )
}

function denyReason(found: Set<SourceResult>, onlyPullRequests: boolean): string {
    const paragraphs: string[] = []
    if (found.has('every')) {
        paragraphs.push(
            "This pushes every branch at once, the ones a wildcard matches, what git's push " +
                'settings pick (`remote.<name>.push`, or `push.default=matching`), or what `xargs` ' +
                "adds, so the push check can't tell what it sends. Name each branch instead: `git " +
                'push origin <branch>`.',
        )
    }
    if (found.has('unknown')) {
        paragraphs.push(
            'This pushes a branch named by a shell variable, or one that does not exist, so the ' +
                "push check can't tell what it sends. Name each branch instead: `git push origin " +
                '<branch>`.',
        )
    }
    if (found.has('moved')) {
        paragraphs.push(
            'This changes what is checked out (`git switch`, `git checkout`, `git rebase`, `git ' +
                "pull` and the like) before it pushes, so the push check can't tell what it will " +
                'send. Run the push as a command of its own.',
        )
    }
    if (found.has('unverified') || found.has('dirty') || found.has('other')) {
        const lines = [
            onlyPullRequests
                ? "This opens a pull request for code that `npm run verify` hasn't passed."
                : "This pushes code that `npm run verify` hasn't passed.",
            '',
            found.has('other')
                ? 'Verify checks the working tree and keeps one record per checkout, so it can only ' +
                  'vouch for what you have checked out. Check out each branch, run `npm run ' +
                  'verify` there, and push it on its own.'
                : 'Run `npm run verify` and fix what fails, then run this command again.',
        ]
        if (found.has('dirty')) {
            lines.push(
                "Verify checks the working tree, which holds changes your last commit doesn't. " +
                    'Commit what belongs in it, and stash the rest with `git stash -u` before you ' +
                    'run verify. `git stash pop` brings them back afterwards.',
            )
        }
        paragraphs.push(lines.join('\n'))
    }
    return [
        paragraphs.join('\n\n'),
        'If it has to be pushed this way anyway, ask the person you are working with to push it ' +
            'themselves.',
        'Details: docs/agents.md',
    ].join('\n')
}
