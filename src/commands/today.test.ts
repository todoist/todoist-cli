import { captureConsole, createTestProgram } from '@todoist/cli-core/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api/core.js', () => ({
    getApi: vi.fn(),
    getCurrentUserId: vi.fn().mockResolvedValue('current-user-123'),
    // The same zone as the machine's, which the test run pins to UTC.
    getAccountTimezone: vi.fn(async () => 'UTC'),
}))

vi.mock('../lib/api/workspaces.js', () => ({
    fetchWorkspaces: vi.fn().mockResolvedValue([]),
}))

vi.mock('../lib/markdown.js', () => ({
    preloadMarkdown: vi.fn().mockResolvedValue(undefined),
    renderMarkdown: vi.fn((text: string) => Promise.resolve(text)),
}))

import { getAccountTimezone } from '../lib/api/core.js'
import { fetchWorkspaces, type Workspace } from '../lib/api/workspaces.js'
import { preloadMarkdown } from '../lib/markdown.js'
import { setupApiMock } from '../test-support/api-mock.js'
import { type MockApi } from '../test-support/mock-api.js'
import { registerTodayCommand } from './today.js'

const mockPreloadMarkdown = vi.mocked(preloadMarkdown)
const mockFetchWorkspaces = vi.mocked(fetchWorkspaces)

function createProgram() {
    return createTestProgram(registerTodayCommand)
}

function getToday(): string {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function getYesterday(): string {
    const d = new Date()
    d.setDate(d.getDate() - 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

describe('today command', () => {
    let mockApi: MockApi
    let consoleSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        vi.clearAllMocks()
        mockApi = setupApiMock()
        consoleSpy = captureConsole()
    })

    it('shows overdue tasks in Overdue section', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({
            results: [
                {
                    id: 'task-1',
                    content: 'Overdue task',
                    projectId: 'proj-1',
                    due: { date: getYesterday(), string: 'yesterday' },
                },
            ],
            nextCursor: null,
        })
        mockApi.getProjects.mockResolvedValue({
            results: [{ id: 'proj-1', name: 'Work' }],
            nextCursor: null,
        })

        await program.parseAsync(['node', 'td', 'today'])

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Overdue'))
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Overdue task'))
    })

    it('shows tasks due today in Today section', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({
            results: [
                {
                    id: 'task-1',
                    content: 'Today task',
                    projectId: 'proj-1',
                    due: { date: getToday(), string: 'today' },
                },
            ],
            nextCursor: null,
        })
        mockApi.getProjects.mockResolvedValue({
            results: [{ id: 'proj-1', name: 'Work' }],
            nextCursor: null,
        })

        await program.parseAsync(['node', 'td', 'today'])

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Today'))
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Today task'))
    })

    it('includes tasks with specific times in today section', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({
            results: [
                {
                    id: 'task-1',
                    content: 'Meeting at 6pm',
                    projectId: 'proj-1',
                    due: { date: `${getToday()}T18:00:00`, string: 'today at 6pm' },
                },
                {
                    id: 'task-2',
                    content: 'Deadline at 9am',
                    projectId: 'proj-1',
                    due: { date: `${getToday()}T09:00:00`, string: 'today at 9am' },
                },
            ],
            nextCursor: null,
        })
        mockApi.getProjects.mockResolvedValue({
            results: [{ id: 'proj-1', name: 'Work' }],
            nextCursor: null,
        })

        await program.parseAsync(['node', 'td', 'today'])

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Today'))
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Meeting at 6pm'))
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Deadline at 9am'))
    })

    it('shows "No tasks due today" when empty', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({ results: [], nextCursor: null })
        mockApi.getProjects.mockResolvedValue({ results: [], nextCursor: null })

        await program.parseAsync(['node', 'td', 'today'])

        expect(consoleSpy).toHaveBeenCalledWith('No tasks due today.')
    })

    it('excludes tasks with future due dates', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({
            results: [
                {
                    id: 'task-1',
                    content: 'Future task',
                    projectId: 'proj-1',
                    due: { date: '2099-12-31', string: 'Dec 31' },
                },
            ],
            nextCursor: null,
        })
        mockApi.getProjects.mockResolvedValue({ results: [], nextCursor: null })

        await program.parseAsync(['node', 'td', 'today'])

        expect(consoleSpy).toHaveBeenCalledWith('No tasks due today.')
    })

    describe("the account's day", () => {
        afterEach(() => {
            vi.useRealTimers()
        })

        it("lists a task due on the account's today under Today when the machine is a day ahead", async () => {
            // 03:00 UTC on 25 November is still 9 PM on the 24th for an account in Chicago.
            vi.useFakeTimers({ toFake: ['Date'] })
            vi.setSystemTime(new Date('2026-11-25T03:00:00Z'))
            vi.mocked(getAccountTimezone).mockResolvedValueOnce('America/Chicago')
            mockApi.getTasksByFilter.mockResolvedValue({
                results: [
                    {
                        id: 'task-1',
                        content: 'Due today',
                        projectId: 'proj-1',
                        due: { date: '2026-11-24' },
                    },
                    {
                        id: 'task-2',
                        content: 'Due yesterday',
                        projectId: 'proj-1',
                        due: { date: '2026-11-23' },
                    },
                ],
                nextCursor: null,
            })

            await createProgram().parseAsync(['node', 'td', 'today'])

            const lines = consoleSpy.mock.calls
                .map((call: unknown[]) => String(call[0]).split('\n')[0].trim())
                .filter((line: string) => line !== '')
            expect(lines.slice(0, 4)).toEqual([
                'Overdue (1)',
                'Due yesterday',
                'Today (1)',
                'Due today',
            ])
        })

        it("keeps a task due on the account's today when the machine is a day behind", async () => {
            // 20:00 UTC on 24 November is already 5 AM on the 25th for an account in Tokyo.
            vi.useFakeTimers({ toFake: ['Date'] })
            vi.setSystemTime(new Date('2026-11-24T20:00:00Z'))
            vi.mocked(getAccountTimezone).mockResolvedValueOnce('Asia/Tokyo')
            mockApi.getTasksByFilter.mockResolvedValue({
                results: [
                    {
                        id: 'task-1',
                        content: 'Due today',
                        projectId: 'proj-1',
                        due: { date: '2026-11-25' },
                    },
                ],
                nextCursor: null,
            })

            await createProgram().parseAsync(['node', 'td', 'today', '--json'])

            const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0]))
            expect(parsed.results.map((task: { id: string }) => task.id)).toEqual(['task-1'])
        })
    })

    it('outputs JSON with --json flag', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({
            results: [
                {
                    id: 'task-1',
                    content: 'Today task',
                    projectId: 'proj-1',
                    due: { date: getToday() },
                },
            ],
            nextCursor: null,
        })

        await program.parseAsync(['node', 'td', 'today', '--json'])

        const output = consoleSpy.mock.calls[0][0]
        const parsed = JSON.parse(output)
        expect(parsed.results).toBeDefined()
        expect(parsed.results[0].content).toBe('Today task')
    })

    it('outputs NDJSON with --ndjson flag', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({
            results: [
                {
                    id: 'task-1',
                    content: 'Task 1',
                    projectId: 'proj-1',
                    due: { date: getToday() },
                },
                {
                    id: 'task-2',
                    content: 'Task 2',
                    projectId: 'proj-1',
                    due: { date: getYesterday() },
                },
            ],
            nextCursor: null,
        })

        await program.parseAsync(['node', 'td', 'today', '--ndjson'])

        const output = consoleSpy.mock.calls[0][0]
        const lines = output.split('\n')
        expect(lines).toHaveLength(2)
    })

    it('skips markdown preload in --raw mode', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({
            results: [
                {
                    id: 'task-1',
                    content: 'Raw task',
                    projectId: 'proj-1',
                    due: { date: getToday() },
                },
            ],
            nextCursor: null,
        })
        mockApi.getProjects.mockResolvedValue({
            results: [{ id: 'proj-1', name: 'Work' }],
            nextCursor: null,
        })

        await program.parseAsync(['node', 'td', 'today', '--raw'])

        expect(mockPreloadMarkdown).not.toHaveBeenCalled()
    })

    it('includes project names in output', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({
            results: [
                {
                    id: 'task-1',
                    content: 'Task',
                    projectId: 'proj-1',
                    due: { date: getToday() },
                },
            ],
            nextCursor: null,
        })
        mockApi.getProjects.mockResolvedValue({
            results: [{ id: 'proj-1', name: 'Work' }],
            nextCursor: null,
        })

        await program.parseAsync(['node', 'td', 'today'])

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Work'))
    })

    it('filters by --personal to show only personal project tasks', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({
            results: [
                {
                    id: 'task-1',
                    content: 'Personal task',
                    projectId: 'proj-personal',
                    due: { date: getToday() },
                },
                {
                    id: 'task-2',
                    content: 'Workspace task',
                    projectId: 'proj-workspace',
                    due: { date: getToday() },
                },
            ],
            nextCursor: null,
        })
        mockApi.getProjects.mockResolvedValue({
            results: [
                { id: 'proj-personal', name: 'Personal' },
                { id: 'proj-workspace', name: 'Work', workspaceId: 'ws-1' },
            ],
            nextCursor: null,
        })

        await program.parseAsync(['node', 'td', 'today', '--personal'])

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Personal task'))
        expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Workspace task'))
    })

    it('filters by --workspace to show only workspace tasks', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({
            results: [
                {
                    id: 'task-1',
                    content: 'Personal task',
                    projectId: 'proj-personal',
                    due: { date: getToday() },
                },
                {
                    id: 'task-2',
                    content: 'Workspace task',
                    projectId: 'proj-workspace',
                    due: { date: getToday() },
                },
            ],
            nextCursor: null,
        })
        mockApi.getProjects.mockResolvedValue({
            results: [
                { id: 'proj-personal', name: 'Personal' },
                { id: 'proj-workspace', name: 'Work', workspaceId: 'ws-1' },
            ],
            nextCursor: null,
        })
        mockFetchWorkspaces.mockResolvedValue([
            { id: 'ws-1', name: 'Acme Corp' } as Partial<Workspace>,
        ] as Workspace[])

        await program.parseAsync(['node', 'td', 'today', '--workspace', 'Acme'])

        expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Personal task'))
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Workspace task'))
    })

    it('throws error when both --workspace and --personal specified', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({ results: [], nextCursor: null })

        await expect(
            program.parseAsync(['node', 'td', 'today', '--workspace', 'Acme', '--personal']),
        ).rejects.toThrow('mutually exclusive')
    })

    it('uses server-side assignee scoping by default', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({ results: [], nextCursor: null })
        mockApi.getProjects.mockResolvedValue({ results: [], nextCursor: null })

        await program.parseAsync(['node', 'td', 'today'])

        expect(mockApi.getTasksByFilter).toHaveBeenCalledWith(
            expect.objectContaining({
                query: '(today | overdue) & (assigned to: me | !assigned)',
            }),
        )
    })

    it('uses broad query with --any-assignee', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({ results: [], nextCursor: null })
        mockApi.getProjects.mockResolvedValue({ results: [], nextCursor: null })

        await program.parseAsync(['node', 'td', 'today', '--any-assignee'])

        expect(mockApi.getTasksByFilter).toHaveBeenCalledWith(
            expect.objectContaining({
                query: 'today | overdue',
            }),
        )
    })

    it('--any-assignee includes tasks assigned to others', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({
            results: [
                {
                    id: 'task-1',
                    content: 'My task',
                    projectId: 'proj-1',
                    responsibleUid: 'current-user-123',
                    due: { date: getToday() },
                },
                {
                    id: 'task-2',
                    content: 'Other task',
                    projectId: 'proj-1',
                    responsibleUid: 'other-user-456',
                    due: { date: getToday() },
                },
            ],
            nextCursor: null,
        })
        mockApi.getProjects.mockResolvedValue({
            results: [{ id: 'proj-1', name: 'Work' }],
            nextCursor: null,
        })

        await program.parseAsync(['node', 'td', 'today', '--any-assignee'])

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('My task'))
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Other task'))
    })

    it('fetches projects in parallel with tasks', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({ results: [], nextCursor: null })
        mockApi.getProjects.mockResolvedValue({ results: [], nextCursor: null })

        await program.parseAsync(['node', 'td', 'today'])

        expect(mockApi.getTasksByFilter).toHaveBeenCalled()
        expect(mockApi.getProjects).toHaveBeenCalled()
    })
})
