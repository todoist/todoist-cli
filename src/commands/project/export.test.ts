import fs from 'node:fs'
import { captureConsole, captureStream, createTestProgram } from '@todoist/cli-core/testing'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs')
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

function createProgram() {
    return createTestProgram(registerProjectCommand)
}

describe('project export', () => {
    let mockApi: MockApi
    let consoleSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        vi.clearAllMocks()
        mockApi = setupApiMock()
        consoleSpy = captureConsole()
        mockResolveProjectRef.mockResolvedValue(fixtures.projects.work)
    })

    it('writes the CSV to stdout', async () => {
        mockApi.exportProjectAsCsv.mockResolvedValue('task,priority\nBuy milk,4')
        const stdoutSpy = captureStream()

        await createProgram().parseAsync(['node', 'td', 'project', 'export', 'Work'])

        expect(mockResolveProjectRef).toHaveBeenCalledWith(mockApi, 'Work')
        expect(mockApi.exportProjectAsCsv).toHaveBeenCalledWith({
            projectId: fixtures.projects.work.id,
            useRelativeDates: undefined,
        })
        expect(stdoutSpy).toHaveBeenCalledWith('task,priority\nBuy milk,4')
    })

    it('writes the CSV to a file with --output, calling it a CSV', async () => {
        mockApi.exportProjectAsCsv.mockResolvedValue('task,priority\nBuy milk,4')

        await createProgram().parseAsync([
            'node',
            'td',
            'project',
            'export',
            'Work',
            '--output',
            '/tmp/work.csv',
        ])

        expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
            '/tmp/work.csv',
            'task,priority\nBuy milk,4',
            'utf-8',
        )
        expect(consoleSpy).toHaveBeenCalledWith('CSV written to /tmp/work.csv')
    })

    it('passes --relative-dates', async () => {
        mockApi.exportProjectAsCsv.mockResolvedValue('content')
        captureStream()

        await createProgram().parseAsync([
            'node',
            'td',
            'project',
            'export',
            'Work',
            '--relative-dates',
        ])

        expect(mockApi.exportProjectAsCsv).toHaveBeenCalledWith({
            projectId: fixtures.projects.work.id,
            useRelativeDates: true,
        })
    })

    it('outputs the CSV as JSON with --json', async () => {
        mockApi.exportProjectAsCsv.mockResolvedValue('csv content')

        await createProgram().parseAsync(['node', 'td', 'project', 'export', 'Work', '--json'])

        expect(JSON.parse(consoleSpy.mock.calls[0][0] as string)).toEqual({
            content: 'csv content',
        })
    })

    it('accepts --project', async () => {
        mockApi.exportProjectAsCsv.mockResolvedValue('content')
        captureStream()

        await createProgram().parseAsync(['node', 'td', 'project', 'export', '--project', 'Work'])

        expect(mockResolveProjectRef).toHaveBeenCalledWith(mockApi, 'Work')
    })

    it('rejects a project given both as argument and --project', async () => {
        await expect(
            createProgram().parseAsync([
                'node',
                'td',
                'project',
                'export',
                'Work',
                '--project',
                'Home',
            ]),
        ).rejects.toMatchObject({ code: 'CONFLICTING_OPTIONS' })
        expect(mockApi.exportProjectAsCsv).not.toHaveBeenCalled()
    })
})
