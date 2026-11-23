import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkCommand, checkoutToGuard, type PushVerdict } from './push-check.ts'
import { writeVerified } from './state.ts'
import { createTempRepo, type TempRepo } from './test-repo.ts'
import { codeFingerprint, snapshot } from './tree.ts'

let repo: TempRepo

function check(command: string, cwd = repo.dir): PushVerdict {
    return checkCommand({ root: repo.dir, command, cwd })
}

/** The reason the check stops `command`, or undefined when it lets it run. */
function denial(command: string, cwd?: string): string | undefined {
    const verdict = check(command, cwd)
    return verdict.decision === 'deny' ? verdict.reason : undefined
}

function markVerified(): void {
    writeVerified(repo.dir, {
        fingerprint: codeFingerprint(snapshot(repo.dir)),
        head: 'x',
        at: 'now',
    })
}

function commitOnBranch(branch: string, path: string, content = 'export const x = 1\n'): void {
    repo.git(['switch', '--quiet', '-c', branch])
    repo.write(path, content)
    repo.git(['add', path])
    repo.git(['commit', '--quiet', '-m', `add ${path}`])
}

const config = (...args: string[]) => repo.git(['config', ...args])

beforeEach(() => {
    // The check reads git's push settings, so the person's own git config must not reach it.
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null')
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    repo = createTempRepo()
    repo.write('.gitignore', '.tmp/\n')
    repo.write('src/a.ts', 'export const a = 1\n')
    repo.write('README.md', 'readme\n')
    repo.git(['add', '.'])
    repo.git(['commit', '--quiet', '-m', 'initial'])
    repo.addOrigin()
})

afterEach(() => {
    repo.cleanup()
    vi.unstubAllEnvs()
})

describe('pushes it checks', () => {
    it('stops a push of code verify has not passed, and allows it once it has', () => {
        commitOnBranch('feature', 'src/b.ts')
        const reason = denial('git push -u origin HEAD')
        expect(reason).toContain("This pushes code that `npm run verify` hasn't passed.")
        expect(reason).toContain('Run `npm run verify` and fix what fails')
        expect(reason).not.toContain('git stash')

        markVerified()
        expect(check('git push -u origin HEAD')).toEqual({ decision: 'allow', notes: [] })
    })

    it('stops a push of a commit that holds less than the tree verify passed', () => {
        commitOnBranch('partial', 'src/committed.ts')
        repo.write('src/uncommitted.ts', 'export const y = 1\n')
        markVerified()
        expect(denial('git push')).toMatch(
            /holds changes your last commit doesn't[\s\S]*git stash -u/,
        )
    })

    it('checks the working tree when the same command commits before it pushes', () => {
        repo.git(['switch', '--quiet', '-c', 'together'])
        repo.write('src/together.ts', 'export const t = 1\n')
        const command = 'git add -A && git commit -m "add together" && git push'
        expect(denial(command)).toContain('npm run verify')
        markVerified()
        expect(check(command).decision).toBe('allow')
    })

    it('stops a new pull request for unverified code, including one for another branch', () => {
        commitOnBranch('pull-request', 'src/feature.ts')
        expect(denial('gh pr create --fill')).toContain(
            "This opens a pull request for code that `npm run verify` hasn't passed.",
        )
        repo.git(['switch', '--quiet', 'main'])
        expect(denial('gh pr create --head pull-request --fill')).toContain('opens a pull request')
    })

    it('checks a push from a subfolder, and one split across lines', () => {
        commitOnBranch('nested', 'src/nested.ts')
        expect(denial('git push', join(repo.dir, 'src'))).toContain('npm run verify')
        expect(denial('git \\\n  push origin nested')).toContain('npm run verify')
    })

    it('stops a push of every branch at once, since there is no one tree to check', () => {
        expect(denial('git push --all origin')).toContain('every branch at once')
        expect(denial("git push origin 'refs/heads/*:refs/heads/*'")).toContain(
            'every branch at once',
        )
    })

    it("stops a push with no refspec when git's push settings pick what it sends", () => {
        commitOnBranch('configured', 'src/configured.ts')
        markVerified()
        expect(check('git push').decision).toBe('allow')

        config('remote.origin.push', 'refs/heads/main:refs/heads/main')
        expect(denial('git push origin')).toContain('push settings pick')
        expect(check('git push origin configured').decision).toBe('allow')
        config('--unset', 'remote.origin.push')

        // Another remote's settings don't change what a push to origin sends…
        config('remote.other.push', 'refs/heads/main:refs/heads/main')
        expect(check('git push origin').decision).toBe('allow')
        // …but they do when git's settings send a bare push there.
        for (const key of [
            'branch.configured.pushRemote',
            'remote.pushDefault',
            'branch.configured.remote',
        ]) {
            config(key, 'other')
            expect(denial('git push'), key).toContain('push settings pick')
            expect(check('git push origin').decision, key).toBe('allow')
            config('--unset', key)
        }
        config('--unset', 'remote.other.push')

        config('remote.origin.mirror', 'yes')
        expect(denial('git push origin')).toContain('push settings pick')
        config('remote.origin.mirror', 'off')
        expect(check('git push origin').decision).toBe('allow')
        config('--unset', 'remote.origin.mirror')

        config('push.default', 'matching')
        expect(denial('git push')).toContain('push settings pick')
        config('--unset', 'push.default')

        // With one remote, a bare push goes there, whatever its name.
        repo.git(['remote', 'rename', 'origin', 'upstream'])
        config('remote.upstream.push', 'refs/heads/main:refs/heads/main')
        expect(denial('git push')).toContain('push settings pick')
    })

    it('checks a branch pushed by name against where that branch left main', () => {
        commitOnBranch('elsewhere', 'src/elsewhere.ts')
        // main moves on after `elsewhere` left it
        repo.git(['switch', '--quiet', 'main'])
        repo.write('src/upstream.ts', 'export const u = 1\n')
        repo.git(['add', '.'])
        repo.git(['commit', '--quiet', '-m', 'upstream'])
        repo.git(['push', '--quiet', 'origin', 'main'])
        commitOnBranch('docs-branch', 'docs/notes.md', '# notes\n')
        repo.git(['switch', '--quiet', 'elsewhere'])

        expect(check('git push origin docs-branch').decision).toBe('allow')
        expect(check('git push origin origin/main:refs/heads/copy').decision).toBe('allow')
        // An unverified branch that is checked out can be verified here…
        expect(denial('git push origin elsewhere')).not.toContain('Check out each branch')
        // …and one that isn't can't.
        repo.git(['switch', '--quiet', 'docs-branch'])
        expect(denial('git push origin elsewhere')).toContain('Check out each branch')
        // A branch the same command makes holds what's checked out.
        markVerified()
        expect(check('git switch -c made && git push -u origin made').decision).toBe('allow')
    })

    it('stops a push on a branch that shares no history with main, as verify records a pass there', () => {
        repo.git(['switch', '--quiet', '--orphan', 'alone'])
        repo.write('docs/notes.md', '# notes\n')
        repo.git(['add', '.'])
        repo.git(['commit', '--quiet', '-m', 'alone'])
        expect(denial('git push origin alone')).toContain('npm run verify')
        markVerified()
        expect(check('git push origin alone').decision).toBe('allow')
    })
})

describe('pushes that need no verify', () => {
    it('allows a branch that changes only docs or files only CI reads', () => {
        commitOnBranch('docs-only', 'docs/notes.md', '# notes\n')
        repo.write('README.md', 'changed\n')
        repo.write('renovate.json', '{}\n')
        repo.git(['add', '.'])
        repo.git(['commit', '--quiet', '-m', 'docs and renovate'])
        expect(check('git push origin docs-only')).toEqual({ decision: 'allow', notes: [] })
        expect(check('gh pr create --fill').decision).toBe('allow')
    })

    it('stops a branch that deletes a doc, since the agent docs may name it', () => {
        repo.git(['switch', '--quiet', '-c', 'no-readme'])
        repo.git(['rm', '--quiet', 'README.md'])
        repo.git(['commit', '--quiet', '-m', 'remove the readme'])
        expect(denial('git push')).toContain('npm run verify')
        // The same, committed in the command that pushes
        repo.git(['reset', '--quiet', '--hard', 'main'])
        rmSync(join(repo.dir, 'README.md'))
        expect(denial('git commit -am "remove it" && git push')).toContain('npm run verify')
    })

    it('allows a branch whose code is what main already has', () => {
        commitOnBranch('undone', 'src/undone.ts')
        repo.git(['rm', '--quiet', 'src/undone.ts'])
        repo.git(['commit', '--quiet', '-m', 'undo'])
        expect(check('git push').decision).toBe('allow')
    })

    it('allows dry runs, deletions and pushes of tags alone', () => {
        commitOnBranch('quiet', 'src/quiet.ts')
        for (const command of [
            'git push --dry-run',
            'git push -n origin quiet',
            'git push origin --delete old',
            'git push origin :old',
            'git push --tags',
        ]) {
            expect(check(command), command).toEqual({ decision: 'allow', notes: [] })
        }
    })
})

describe('pushes it leaves alone, and says so', () => {
    it('lets a push from another checkout through without a word', () => {
        commitOnBranch('here', 'src/here.ts')
        const other = createTempRepo()
        try {
            expect(check(`cd '${other.dir}' && git push`)).toEqual({ decision: 'allow', notes: [] })
        } finally {
            other.cleanup()
        }
    })

    it("notes a push from a folder it can't name, or that isn't in a checkout yet", () => {
        commitOnBranch('unnamed', 'src/unnamed.ts')
        expect(check('cd "$REPO" && git push')).toEqual({
            decision: 'allow',
            notes: ["can't tell which folder a push runs in, so it isn't checked"],
        })
        const made = check('mkdir -p newdir && cd newdir && git push')
        expect(made.decision).toBe('allow')
        expect(made.notes).toEqual([expect.stringMatching(/can't find the checkout of .*newdir/)])
    })

    it("notes a pull request for a branch it can't find", () => {
        expect(check('gh pr create --head nowhere')).toEqual({
            decision: 'allow',
            notes: ["can't find nowhere, so the pull request isn't checked"],
        })
    })

    it('ignores commands that push nothing', () => {
        commitOnBranch('reading', 'src/reading.ts')
        for (const command of ['git status', 'git commit -m "then git push"', 'gh pr view']) {
            expect(check(command), command).toEqual({ decision: 'allow', notes: [] })
        }
    })
})

describe('checkoutToGuard', () => {
    function addWorktree(name: string): string {
        const tree = join(dirname(repo.dir), `${repo.dir.split('/').pop()}-${name}`)
        repo.git(['worktree', 'add', '--quiet', '-b', name, tree])
        return tree
    }

    it('guards another worktree of this repository the agent works in, when it has the guard', () => {
        const tree = addWorktree('linked')
        try {
            expect(checkoutToGuard(repo.dir, join(tree))).toBe(repo.dir)
            mkdirSync(join(tree, '.agents/scripts'), { recursive: true })
            writeFileSync(join(tree, '.agents/scripts/guard.ts'), '')
            expect(checkoutToGuard(repo.dir, tree)).toBe(tree)
        } finally {
            repo.git(['worktree', 'remove', '--force', tree])
        }
    })

    it('never guards another repository, or a folder outside any', () => {
        const other = createTempRepo()
        try {
            other.write('.agents/scripts/guard.ts', '')
            expect(checkoutToGuard(repo.dir, other.dir)).toBe(repo.dir)
            expect(checkoutToGuard(repo.dir, dirname(repo.dir))).toBe(repo.dir)
            expect(checkoutToGuard(repo.dir, undefined)).toBe(repo.dir)
        } finally {
            other.cleanup()
        }
    })
})
