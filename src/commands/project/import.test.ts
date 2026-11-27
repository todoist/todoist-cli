import fs from 'node:fs'
import { open } from 'node:fs/promises'
import { captureConsole, createTestProgram } from '@todoist/cli-core/testing'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs')
vi.mock('node:fs/promises', () => ({
    open: vi.fn(),
}))
vi.mock('../../lib/api/core.js', () => ({
    getApi: vi.fn(),
}))
vi.mock('../../lib/refs.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../lib/refs.js')>()
    return {
        ...actual,
        resolveProjectRef: vi.fn(),
    }
})

import { resolveProjectRef } from '../../lib/refs.js'
import { setupApiMock } from '../../test-support/api-mock.js'
import { fixtures } from '../../test-support/fixtures.js'
import { type MockApi } from '../../test-support/mock-api.js'
import { registerProjectCommand } from './index.js'

const mockResolveProjectRef = vi.mocked(resolveProjectRef)

const importResult = {
    status: 'ok',
    templateType: 'project',
    projects: [],
    sections: [fixtures.sections.planning],
    tasks: [fixtures.tasks.basic, fixtures.tasks.basic],
    comments: [],
} as unknown as Awaited<ReturnType<MockApi['importCsvIntoProject']>>

function run(...args: string[]) {
    return createTestProgram(registerProjectCommand).parseAsync([
        'node',
        'td',
        'project',
        'import',
        ...args,
    ])
}

describe('project import', () => {
    let mockApi: MockApi
    let consoleSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        vi.clearAllMocks()
        mockApi = setupApiMock()
        consoleSpy = captureConsole()
        mockResolveProjectRef.mockResolvedValue(fixtures.projects.work)
        vi.mocked(open).mockResolvedValue({ close: vi.fn() } as unknown as Awaited<
            ReturnType<typeof open>
        >)
        vi.mocked(fs.openAsBlob).mockResolvedValue(new Blob([Buffer.from('csv content')]))
        mockApi.importCsvIntoProject.mockResolvedValue(importResult)
        mockApi.importTemplateFromId.mockResolvedValue(importResult)
    })

    describe('--from-csv', () => {
        it('uploads the CSV into the project', async () => {
            await run('Work', '--from-csv', '/tmp/roadmap.csv')

            expect(mockResolveProjectRef).toHaveBeenCalledWith(mockApi, 'Work')
            const arg = mockApi.importCsvIntoProject.mock.calls[0][0]
            expect(arg).toMatchObject({
                projectId: fixtures.projects.work.id,
                fileName: 'roadmap.csv',
            })
            expect(await (arg.file as Blob).text()).toBe('csv content')
            expect(mockApi.importTemplateFromId).not.toHaveBeenCalled()
            expect(consoleSpy).toHaveBeenCalledWith(`Imported into: ${fixtures.projects.work.name}`)
            expect(consoleSpy).toHaveBeenCalledWith('Imported: 2 tasks, 1 sections')
        })

        it('sends --file-name instead of the file basename', async () => {
            await run('Work', '--from-csv', '/tmp/roadmap.csv', '--file-name', 'Q2 plan.csv')

            expect(mockApi.importCsvIntoProject.mock.calls[0][0].fileName).toBe('Q2 plan.csv')
        })

        it('fails with FILE_NOT_FOUND before calling the API', async () => {
            vi.mocked(open).mockRejectedValue(
                Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
            )

            await expect(run('Work', '--from-csv', '/tmp/missing.csv')).rejects.toMatchObject({
                code: 'FILE_NOT_FOUND',
            })
            expect(mockApi.importCsvIntoProject).not.toHaveBeenCalled()
        })
    })

    describe('--from-template', () => {
        it('imports the template into the project', async () => {
            await run('Work', '--from-template', 'product-launch', '--locale', 'fr')

            expect(mockApi.importTemplateFromId).toHaveBeenCalledWith({
                projectId: fixtures.projects.work.id,
                templateId: 'product-launch',
                locale: 'fr',
            })
            expect(mockApi.importCsvIntoProject).not.toHaveBeenCalled()
        })
    })

    it('accepts --project', async () => {
        await run('--project', 'Work', '--from-template', 'product-launch')

        expect(mockResolveProjectRef).toHaveBeenCalledWith(mockApi, 'Work')
    })

    it('outputs the API result with --json', async () => {
        await run('Work', '--from-template', 'product-launch', '--json')

        const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string)
        expect(parsed.status).toBe('ok')
        expect(parsed.tasks).toHaveLength(2)
    })

    it('previews with --dry-run without calling the API', async () => {
        await run('Work', '--from-template', 'product-launch', '--dry-run')

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[dry-run]'))
        expect(mockApi.importTemplateFromId).not.toHaveBeenCalled()
    })

    describe('options per source', () => {
        it.each([
            [['Work'], 'INVALID_OPTIONS'],
            [['Work', '--from-csv', '/tmp/a.csv', '--from-template', 'x'], 'CONFLICTING_OPTIONS'],
            [['Work', '--from-template', 'x', '--file-name', 'a.csv'], 'INVALID_OPTIONS'],
            [['Work', '--from-csv', '/tmp/a.csv', '--locale', 'fr'], 'INVALID_OPTIONS'],
            [['Work', '--project', 'Home', '--from-template', 'x'], 'CONFLICTING_OPTIONS'],
        ])('rejects %j with %s and imports nothing', async (args, code) => {
            await expect(run(...args)).rejects.toMatchObject({ code })
            expect(mockApi.importCsvIntoProject).not.toHaveBeenCalled()
            expect(mockApi.importTemplateFromId).not.toHaveBeenCalled()
        })
    })
})
