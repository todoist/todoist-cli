// Finds what a shell command pushes: each `git push`, new pull request and commit it runs, in
// order, with the folder each runs in, and the commands before them that change what's checked
// out. Nothing here runs the command or git.

import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { readCommands, type ShellItem } from './shell-commands.ts'

/**
 * - `push`, `pr`: what a push or a new pull request sends, as git names it in `sources` (`HEAD`, a
 *   branch, `refs/tags/v1`); `*` when it can't be told from the command: every branch, a wildcard,
 *   what git's push settings pick, or arguments `xargs` adds.
 * - `commit`: a commit, so a later push from that folder sends the working tree.
 * - `create`: a branch made from what's checked out, named in `sources`.
 * - `move`: a command that changes what's checked out, such as `git switch` or `git rebase`.
 * - `dir`: the folder it runs in, or null when the command doesn't say, as after `cd "$REPO"`.
 * - `implicit`: a push with no refspec, so git's settings decide what it sends, to `remote` (null
 *   when the command names none).
 */
export type PushTarget = {
    kind: 'push' | 'pr' | 'commit' | 'create' | 'move'
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
    [
        'sudo',
        ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from'],
    ],
    ['xargs', ['-I', '-L', '-n', '-P', '-d', '-E', '-s', '-a', '--arg-file', '--delimiter']],
])

/** Shells whose `-c` runs a command given as a string. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

/** Git commands that change what's checked out, except in the forms `isMove` lets through. */
const MOVES = new Set([
    'switch',
    'checkout',
    'reset',
    'rebase',
    'merge',
    'pull',
    'cherry-pick',
    'revert',
    'am',
])

export function findTargets(command: string, cwd: string): PushTarget[] {
    const targets: PushTarget[] = []
    walk(readCommands(command), cwd, targets)
    return targets
}

/** Reads the commands in `items` from folder `dir`, and returns the folder they end in. */
function walk(items: ShellItem[], start: string | null, targets: PushTarget[]): string | null {
    const dirs: (string | null)[] = []
    let dir = start
    for (const item of items) {
        if (item.type === 'enter') dirs.push(dir)
        // Back to the folder before the subshell, even when that was unknown.
        else if (item.type === 'leave') {
            if (dirs.length > 0) dir = dirs.pop() ?? null
        } else dir = readCommand(item.words, dir, targets)
    }
    return dir
}

/** Reads one simple command, and returns the folder the next one runs in. */
function readCommand(words: string[], dir: string | null, targets: PushTarget[]): string | null {
    const { start, inDir, extraArgs, nested } = skipWrappers(words, dir)
    // `env -S '…'`: a command given as a string
    if (nested !== undefined) {
        walk(readCommands(nested), inDir, targets)
        return dir
    }
    const name = basename(words[start] ?? '')
    const rest = words.slice(start + 1)
    if (name === 'cd')
        return resolveDir(dir, rest.find((word) => !/^(-[LPe@]+|--)$/.test(word)) ?? '~')
    if (name === 'pushd') {
        // `pushd -n` adds to the stack without changing folder; `+N` and `-N` rotate it.
        if (rest.includes('-n')) return dir
        const to = rest.find((word) => word !== '--')
        return to !== undefined && /^[+-]\d+$/.test(to) ? null : resolveDir(dir, to ?? '~')
    }
    // `eval` runs its words as a command in this shell, so a `cd` in it stays.
    if (name === 'eval') return walk(readCommands(rest.join(' ')), inDir, targets)
    if (SHELLS.has(name)) {
        const script = shellScript(rest)
        if (script !== undefined) walk(readCommands(script), inDir, targets)
    } else if (name === 'git') readGit(words, start + 1, inDir, extraArgs, targets)
    else if (name === 'gh') readGh(words, start + 1, inDir, extraArgs, targets)
    return dir
}

/** The command string a shell's `-c` runs: `bash -lc 'git push'`. */
function shellScript(args: string[]): string | undefined {
    let runsString = false
    for (let i = 0; i < args.length; i++) {
        const word = args[i] as string
        if (word === '--' || !word.startsWith('-')) return runsString ? word : undefined
        if (word === '-o' || word === '--rcfile' || word === '--init-file') i++
        else if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(word)) runsString = true
    }
    return undefined
}

/**
 * Skips the shell keywords, variable assignments and wrapper commands (`env`, `sudo`, `xargs`, …)
 * before a command, with their options. `env -C` changes the folder for that command only, and
 * `env -S` gives the command as one string. A command `xargs` runs gets arguments nobody can see.
 */
function skipWrappers(
    words: string[],
    dir: string | null,
): { start: number; inDir: string | null; extraArgs: boolean; nested?: string } {
    let i = 0
    let inDir = dir
    let extraArgs = false
    while (i < words.length) {
        const word = words[i] as string
        if (KEYWORDS.has(word) || /^[A-Za-z_]\w*=/.test(word)) {
            i++
            continue
        }
        const name = basename(word)
        const valueOptions = WRAPPERS.get(name)
        if (!valueOptions) break
        if (name === 'xargs') extraArgs = true
        for (i++; i < words.length && (words[i] as string).startsWith('-'); i++) {
            const option = words[i] as string
            if (option === '--') {
                i++
                break
            }
            // `command -v git` prints where git is; it runs nothing.
            if (name === 'command' && /^-[a-zA-Z]*[vV]/.test(option)) {
                return { start: words.length, inDir, extraArgs }
            }
            const [flag = option, value] = option.split(/=(.*)/s)
            const operand = value ?? (valueOptions.includes(flag) ? words[++i] : undefined)
            if (name === 'env' && (flag === '-S' || flag === '--split-string')) {
                return { start: words.length, inDir, extraArgs, nested: operand ?? '' }
            }
            if (name === 'env' && (flag === '-C' || flag === '--chdir')) {
                inDir = resolveDir(inDir, operand ?? '')
            } else if (name === 'env' && /^-C./.test(option)) {
                inDir = resolveDir(inDir, option.slice(2))
            }
        }
        // timeout's first operand is how long to wait.
        if (name === 'timeout') i++
    }
    return { start: i, inDir, extraArgs }
}

/** The folder `to` names from `from`, or null when it can't tell, as for a variable or `cd -`. */
function resolveDir(from: string | null, to: string): string | null {
    if (to === '~') return homedir()
    if (to.startsWith('~/')) return join(homedir(), to.slice(2))
    if (!to || to === '-' || /[$*?[~]/.test(to)) return null
    if (isAbsolute(to)) return to
    return from === null ? null : resolve(from, to)
}

function readGit(
    words: string[],
    start: number,
    dir: string | null,
    extraArgs: boolean,
    targets: PushTarget[],
): void {
    let i = start
    let inDir = dir
    // An inline `push.*`, `remote.*` or `branch.*` setting can change what a push with no refspec
    // sends, or where.
    let configured = false
    for (; i < words.length; i++) {
        const word = words[i] as string
        if (word === '-C') inDir = resolveDir(inDir, words[++i] ?? '')
        else if (/^-C./.test(word)) inDir = resolveDir(inDir, word.slice(2))
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
    const subcommand = words[i] ?? ''
    const args = words.slice(i + 1)
    if (subcommand === 'commit') targets.push({ kind: 'commit', dir: inDir, sources: [] })
    const created = createdBranch(subcommand, args)
    if (created !== undefined) targets.push({ kind: 'create', dir: inDir, sources: [created] })
    else if (MOVES.has(subcommand) && isMove(subcommand, args)) {
        targets.push({ kind: 'move', dir: inDir, sources: [] })
    }
    if (subcommand !== 'push') return
    const push = readPush(args, configured || extraArgs)
    if (push) targets.push({ ...push, dir: inDir })
}

/** The branch `git switch -c`, `git checkout -b` or `git branch` makes from what's checked out. */
function createdBranch(subcommand: string, args: string[]): string | undefined {
    const operands = args.filter((word) => !word.startsWith('-'))
    if (subcommand === 'branch') {
        // `git branch name` alone; with a start point, or any option, it isn't what's checked out
        return args.length === 1 && operands.length === 1 ? operands[0] : undefined
    }
    const flags =
        subcommand === 'switch' ? ['-c', '-C', '--create', '--force-create'] : ['-b', '-B']
    if (!['switch', 'checkout'].includes(subcommand)) return undefined
    const at = args.findIndex((word) => flags.includes(word))
    if (at === -1) return undefined
    const name = args[at + 1]
    // A start point after the name means the new branch, and HEAD, move there.
    const after = args.slice(at + 2).filter((word) => !word.startsWith('-'))
    return name !== undefined && after.length === 0 ? name : undefined
}

/** Whether a git command that can change what's checked out does here. */
function isMove(subcommand: string, args: string[]): boolean {
    const dashes = args.indexOf('--')
    const before = dashes === -1 ? args : args.slice(0, dashes)
    const operands = before.filter((word) => !word.startsWith('-'))
    // `git checkout -- file` and `git reset -- file` restore files and keep HEAD.
    if (subcommand === 'checkout' && dashes !== -1 && operands.length === 0) return false
    if (subcommand === 'reset') return operands.some((word) => word !== 'HEAD')
    return true
}

function readPush(args: string[], unclear: boolean): Omit<PushTarget, 'dir'> | undefined {
    let remote: string | null = null
    // A remote named as an argument wins over `--repo`, as in git.
    let repoOption: string | null = null
    let tags = false
    let every = false
    const refspecs: string[] = []
    for (let i = 0; i < args.length; i++) {
        const word = args[i] as string
        // A dry run sends nothing, and a deletion sends no code.
        if (['-n', '--dry-run', '-d', '--delete'].includes(word)) return undefined
        if (word === '--tags') tags = true
        else if (['--all', '--branches', '--mirror'].includes(word)) every = true
        else if (word === '--repo') repoOption = args[++i] ?? null
        else if (word.startsWith('--repo=')) repoOption = word.slice('--repo='.length)
        else if (['-o', '--push-option', '--receive-pack', '--exec'].includes(word)) i++
        else if (/^-[^-]*[nd]/.test(word) && !word.startsWith('-o')) return undefined
        else if (word.startsWith('-')) continue
        else if (remote === null) remote = word
        else refspecs.push(word)
    }
    remote ??= repoOption
    if (every || (unclear && refspecs.length === 0)) return { kind: 'push', sources: ['*'] }
    if (refspecs.length === 0) {
        // With --tags and no refspec, it pushes tags alone, which hold no new code.
        if (tags) return undefined
        return { kind: 'push', sources: ['HEAD'], implicit: true, remote }
    }
    // `:` alone pushes every branch both sides have, like --all.
    if (refspecs.some((spec) => spec === ':' || spec === '+:')) {
        return { kind: 'push', sources: ['*'] }
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
    if (sources.length === 0) return undefined
    // `xargs` may add more refspecs than the command shows.
    return { kind: 'push', sources: unclear ? ['*'] : sources }
}

/**
 * `gh pr create`, or `gh pr new`, opens a pull request for the current branch, or for `--head`.
 * `gh pr checkout` changes what's checked out.
 */
function readGh(
    words: string[],
    start: number,
    dir: string | null,
    extraArgs: boolean,
    targets: PushTarget[],
): void {
    let at = start
    // Global options before the subcommand: `gh -R owner/repo pr create`.
    while (/^(-R|--repo)$/.test(words[at] ?? '')) at += 2
    while ((words[at] ?? '').startsWith('--repo=')) at++
    if (words[at] !== 'pr') return
    if (words[at + 1] === 'checkout') {
        targets.push({ kind: 'move', dir, sources: [] })
        return
    }
    if (!['create', 'new'].includes(words[at + 1] ?? '')) return
    let head = 'HEAD'
    for (let i = at + 2; i < words.length; i++) {
        const word = words[i] as string
        if (word === '-H' || word === '--head') head = words[++i] ?? 'HEAD'
        else if (word.startsWith('--head=')) head = word.slice('--head='.length)
    }
    // A head in someone's fork, `owner:branch`, is still that branch.
    const source = extraArgs ? '*' : head.replace(/^[^:]*:/, '')
    targets.push({ kind: 'pr', dir, sources: [source] })
}
