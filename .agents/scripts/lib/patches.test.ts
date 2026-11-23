import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { branchPatchId, hasPassedPatch, readPassedPatches, recordPassedPatch } from './patches.ts'
import { createTempRepo, type TempRepo } from './test-repo.ts'

let repo: TempRepo

const rev = (ref: string) => repo.git(['rev-parse', ref]).stdout.trim()
const base = (ref = 'HEAD') => repo.git(['merge-base', ref, 'main']).stdout.trim()

const LINES = Array.from({ length: 30 }, (_, i) => `export const line${i} = ${i}`)

function commit(path: string, content: string, message = `change ${path}`): void {
    repo.write(path, content)
    repo.git(['add', path])
    repo.git(['commit', '--quiet', '-m', message])
}

/** Moves `main` on with `path`, then rebases `branch` onto it and returns to `branch`. */
function moveMainAndRebase(branch: string, path: string, content: string): void {
    repo.git(['switch', '--quiet', 'main'])
    commit(path, content, 'main moves on')
    repo.git(['switch', '--quiet', branch])
    const rebase = repo.git(['rebase', '--quiet', 'main'])
    if (rebase.status !== 0) throw new Error(rebase.stderr)
}

beforeEach(() => {
    repo = createTempRepo()
    repo.write('src/other.ts', 'export const other = 1\n')
    commit('src/a.ts', `${LINES.join('\n')}\n`, 'initial')
    repo.git(['switch', '--quiet', '-c', 'feature'])
    commit('src/a.ts', `${LINES.join('\n').replace('line15 = 15', 'line15 = 150')}\n`)
})

afterEach(() => repo.cleanup())

describe('branchPatchId', () => {
    it('keeps the id when a rebase moved the base under unchanged changes', () => {
        const before = branchPatchId(repo.dir, base(), 'HEAD')
        moveMainAndRebase('feature', 'src/other.ts', 'export const other = 2\n')
        expect(rev('HEAD')).not.toBe(rev('ORIG_HEAD'))
        expect(branchPatchId(repo.dir, base(), 'HEAD')).toBe(before)

        // Lines added far above the change only shift its line numbers
        const shifted = ['// a comment', ...LINES].join('\n')
        repo.git(['switch', '--quiet', 'main'])
        commit('src/a.ts', `${shifted}\n`, 'main adds a comment at the top')
        repo.git(['switch', '--quiet', 'feature'])
        repo.git(['rebase', '--quiet', 'main'])
        expect(branchPatchId(repo.dir, base(), 'HEAD')).toBe(before)
    })

    it('changes the id when the base changed the lines around the change', () => {
        const before = branchPatchId(repo.dir, base(), 'HEAD')
        moveMainAndRebase(
            'feature',
            'src/a.ts',
            `${LINES.join('\n').replace('line13 = 13', 'line13 = 130')}\n`,
        )
        expect(branchPatchId(repo.dir, base(), 'HEAD')).not.toBe(before)
    })

    it('changes the id for a change only in whitespace, or only in binary content', () => {
        const before = branchPatchId(repo.dir, base(), 'HEAD')
        repo.git(['switch', '--quiet', '-c', 'spaced', 'main'])
        commit('src/a.ts', `${LINES.join('\n').replace('line15 = 15', 'line15 =  150')}\n`)
        expect(branchPatchId(repo.dir, base(), 'HEAD')).not.toBe(before)

        const ids = ['one', 'two'].map((name) => {
            repo.git(['switch', '--quiet', '-c', `binary-${name}`, 'main'])
            commit('icon.png', `\u0000binary ${name}`)
            return branchPatchId(repo.dir, base(), 'HEAD')
        })
        expect(ids[0]).toBeDefined()
        expect(ids[0]).not.toBe(ids[1])
    })

    it('has no id for a commit that changes nothing since the base', () => {
        expect(branchPatchId(repo.dir, rev('main'), 'main')).toBeUndefined()
    })
})

describe('passed patches', () => {
    it('finds a recorded patch on a newer base, and only there', () => {
        recordPassedPatch(repo.dir, base(), 'HEAD')
        expect(hasPassedPatch(repo.dir, base(), 'HEAD')).toBe(true)
        moveMainAndRebase('feature', 'src/other.ts', 'export const other = 2\n')
        expect(hasPassedPatch(repo.dir, base(), 'HEAD')).toBe(true)

        // The same changes on a base the recorded one isn't part of
        repo.git(['switch', '--quiet', '--orphan', 'unrelated'])
        commit('src/a.ts', `${LINES.join('\n')}\n`, 'unrelated history')
        const elsewhere = rev('HEAD')
        commit('src/a.ts', `${LINES.join('\n').replace('line15 = 15', 'line15 = 150')}\n`)
        expect(branchPatchId(repo.dir, elsewhere, 'HEAD')).toBe(
            readPassedPatches(repo.dir)[0]?.patchId,
        )
        expect(hasPassedPatch(repo.dir, elsewhere, 'HEAD')).toBe(false)
    })

    it('does not find changes that never passed', () => {
        recordPassedPatch(repo.dir, base(), 'HEAD')
        commit('src/a.ts', 'export const changed = true\n')
        expect(hasPassedPatch(repo.dir, base(), 'HEAD')).toBe(false)
    })

    it('keeps one entry per patch and base, and the 50 newest', () => {
        recordPassedPatch(repo.dir, base(), 'HEAD')
        recordPassedPatch(repo.dir, base(), 'HEAD')
        expect(readPassedPatches(repo.dir)).toHaveLength(1)
        for (let i = 0; i < 55; i++) {
            commit('src/b.ts', `export const b = ${i}\n`)
            recordPassedPatch(repo.dir, base(), 'HEAD')
        }
        const patches = readPassedPatches(repo.dir)
        expect(patches).toHaveLength(50)
        expect(patches.at(-1)?.patchId).toBe(branchPatchId(repo.dir, base(), 'HEAD'))
    })
})
