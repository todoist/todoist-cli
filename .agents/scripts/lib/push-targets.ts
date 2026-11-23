// Finds what a shell command pushes: each `git push`, new pull request and commit it runs, in
// order, with the folder each runs in. Nothing here runs the command or git.

import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { readCommands } from './shell-commands.ts'

/**
 * - `dir`: the folder it runs in, or null when the command doesn't say, as after `cd "$REPO"`.
 * - `sources`: what it pushes, as git names it (`HEAD`, a branch, `refs/tags/v1`); `*` for every
 *   branch, or a set of them a wildcard picks.
 * - `implicit`: a push with no refspec, so git's settings decide what it sends, to `remote` (null
 *   when the command names none).
 */
export type PushTarget = {
    kind: 'push' | 'pr' | 'commit'
    dir: string | null
    sources: string[]
    implicit?: boolean
    remote?: string | null
}

/** Shell words before a command that run the command after them. */
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{'])

/** Commands that run the command after them, with the options of each that take a value. */
const WRAPPERS = new Map<string, string[]>([
    ['command', []],
    ['builtin', []],
    ['exec', ['-a']],
    ['nohup', []],
    ['time', ['-f', '--format', '-o', '--output']],
    ['env', ['-u', '--unset', '-C', '--chdir', '-S', '--split-string']],
    ['timeout', ['-s', '--signal', '-k', '--kill-after']],
])

export function findTargets(command: string, cwd: string): PushTarget[] {
    const targets: PushTarget[] = []
    const dirs: (string | null)[] = []
    let dir: string | null = cwd
    for (const item of readCommands(command)) {
        if (item.type === 'enter') dirs.push(dir)
        // Back to the folder before the subshell, even when that was unknown.
        else if (item.type === 'leave') {
            if (dirs.length > 0) dir = dirs.pop() ?? null
        } else {
            const { words } = item
            const { start, inDir } = skipWrappers(words, dir)
            const name = basename(words[start] ?? '')
            if (name === 'cd' || name === 'pushd') {
                const to = words.slice(start + 1).find((word) => !/^(-[LPe@]|--)$/.test(word))
                dir = resolveDir(dir, to ?? '~')
            } else if (name === 'git') readGit(words, start + 1, inDir, targets)
            else if (name === 'gh') readGh(words, start + 1, inDir, targets)
        }
    }
    return targets
}

/**
 * Skips the shell keywords, variable assignments and wrapper commands (`env`, `timeout`, …) before
 * a command, with their options. `env -C` changes the folder for that command only.
 */
function skipWrappers(
    words: string[],
    dir: string | null,
): { start: number; inDir: string | null } {
    let i = 0
    let inDir = dir
    while (i < words.length) {
        const word = words[i] as string
        if (KEYWORDS.has(word) || /^[A-Za-z_]\w*=/.test(word)) {
            i++
            continue
        }
        const name = basename(word)
        const valueOptions = WRAPPERS.get(name)
        if (!valueOptions) break
        for (i++; i < words.length && (words[i] as string).startsWith('-'); i++) {
            const option = words[i] as string
            if (option === '--') {
                i++
                break
            }
            // `command -v git` prints where git is; it runs nothing.
            if (name === 'command' && /^-[a-zA-Z]*[vV]/.test(option)) {
                return { start: words.length, inDir }
            }
            const [flag = option, value] = option.split(/=(.*)/s)
            const operand = value ?? (valueOptions.includes(flag) ? words[++i] : undefined)
            if (name === 'env' && (flag === '-C' || flag === '--chdir')) {
                inDir = resolveDir(inDir, operand ?? '')
            } else if (name === 'env' && /^-C./.test(option)) {
                inDir = resolveDir(inDir, option.slice(2))
            }
        }
        // timeout's first operand is how long to wait.
        if (name === 'timeout') i++
    }
    return { start: i, inDir }
}

/** The folder `to` names from `from`, or null when it can't tell, as for a variable or `cd -`. */
function resolveDir(from: string | null, to: string): string | null {
    if (to === '~') return homedir()
    if (to.startsWith('~/')) return join(homedir(), to.slice(2))
    if (!to || to === '-' || /[$*?[~]/.test(to)) return null
    if (isAbsolute(to)) return to
    return from === null ? null : resolve(from, to)
}

function readGit(words: string[], start: number, dir: string | null, targets: PushTarget[]): void {
    let i = start
    let inDir = dir
    // An inline `push.*`, `remote.*` or `branch.*` setting can change what a push with no refspec
    // sends, or where.
    let configured = false
    for (; i < words.length; i++) {
        const word = words[i] as string
        if (word === '-C') inDir = resolveDir(inDir, words[++i] ?? '')
        else if (word === '-c' || word === '--config-env' || word.startsWith('--config-env=')) {
            const setting = word.startsWith('--config-env=')
                ? word.slice('--config-env='.length)
                : (words[++i] ?? '')
            if (/^(push|remote|branch)\./i.test(setting)) configured = true
        } else if (word === '--namespace') i++
        else if (word === '--git-dir' || word === '--work-tree') {
            i++
            inDir = null
        } else if (word.startsWith('--git-dir=') || word.startsWith('--work-tree=')) inDir = null
        else if (!word.startsWith('-')) break
    }
    if (words[i] === 'commit') targets.push({ kind: 'commit', dir: inDir, sources: [] })
    if (words[i] !== 'push') return

    let remote: string | null = null
    // A remote named as an argument wins over `--repo`, as in git.
    let repoOption: string | null = null
    let tags = false
    let every = false
    const refspecs: string[] = []
    for (i++; i < words.length; i++) {
        const word = words[i] as string
        // A dry run sends nothing, and a deletion sends no code.
        if (['-n', '--dry-run', '-d', '--delete'].includes(word)) return
        if (word === '--tags') tags = true
        else if (['--all', '--branches', '--mirror'].includes(word)) every = true
        else if (word === '--repo') repoOption = words[++i] ?? null
        else if (word.startsWith('--repo=')) repoOption = word.slice('--repo='.length)
        else if (['-o', '--push-option', '--receive-pack', '--exec'].includes(word)) i++
        else if (/^-[^-]*[nd]/.test(word) && !word.startsWith('-o')) return
        else if (word.startsWith('-')) continue
        else if (remote === null) remote = word
        else refspecs.push(word)
    }
    remote ??= repoOption
    if (every || (configured && refspecs.length === 0)) {
        targets.push({ kind: 'push', dir: inDir, sources: ['*'] })
        return
    }
    if (refspecs.length === 0) {
        // With --tags and no refspec, it pushes tags alone, which hold no new code.
        if (!tags) {
            targets.push({ kind: 'push', dir: inDir, sources: ['HEAD'], implicit: true, remote })
        }
        return
    }
    // `:` alone pushes every branch both sides have, like --all.
    if (refspecs.some((spec) => spec === ':' || spec === '+:')) {
        targets.push({ kind: 'push', dir: inDir, sources: ['*'] })
        return
    }
    // `+` forces, `:<dst>` deletes, and `tag <name>` names a tag.
    const sources: string[] = []
    for (let k = 0; k < refspecs.length; k++) {
        const spec = refspecs[k] as string
        const tag = refspecs[k + 1]
        if (spec === 'tag' && tag !== undefined) {
            sources.push(`refs/tags/${tag}`)
            k++
            continue
        }
        const forced = spec.replace(/^\+/, '')
        if (!forced.startsWith(':')) sources.push(forced.split(':')[0] as string)
    }
    if (sources.length > 0) targets.push({ kind: 'push', dir: inDir, sources })
}

/** `gh pr create`, or `gh pr new`, opens a pull request for the current branch, or for `--head`. */
function readGh(words: string[], start: number, dir: string | null, targets: PushTarget[]): void {
    let at = start
    // Global options before the subcommand: `gh -R owner/repo pr create`.
    while (/^(-R|--repo)$/.test(words[at] ?? '')) at += 2
    while ((words[at] ?? '').startsWith('--repo=')) at++
    if (words[at] !== 'pr' || !['create', 'new'].includes(words[at + 1] ?? '')) return
    let head = 'HEAD'
    for (let i = at + 2; i < words.length; i++) {
        const word = words[i] as string
        if (word === '-H' || word === '--head') head = words[++i] ?? 'HEAD'
        else if (word.startsWith('--head=')) head = word.slice('--head='.length)
    }
    // A head in someone's fork, `owner:branch`, is still that branch.
    targets.push({ kind: 'pr', dir, sources: [head.replace(/^[^:]*:/, '')] })
}
