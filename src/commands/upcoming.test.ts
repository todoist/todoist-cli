import { captureConsole, createTestProgram } from '@todoist/cli-core/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api/core.js', () => ({
    getApi: vi.fn(),
    getCurrentUserId: vi.fn().mockResolvedValue('current-user-123'),
    // The same zone as the machine's, which the test run pins to UTC.
    getAccountTimezone: vi.fn(async () => 'UTC'),
}))

import { getAccountTimezone } from '../lib/api/core.js'
import { setupApiMock } from '../test-support/api-mock.js'
import { type MockApi } from '../test-support/mock-api.js'
import { registerUpcomingCommand } from './upcoming.js'

function createProgram() {
    return createTestProgram(registerUpcomingCommand)
}

function getDateOffset(days: number): string {
    const d = new Date()
    d.setDate(d.getDate() + days)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

describe('upcoming command', () => {
    let mockApi: MockApi
    let consoleSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        vi.clearAllMocks()
        mockApi = setupApiMock()
        consoleSpy = captureConsole()
    })

    it('defaults to 7 days', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({
            results: [
                {
                    id: 'task-1',
                    content: 'Task in range',
                    projectId: 'proj-1',
                    due: { date: getDateOffset(3) },
                },
            ],
            nextCursor: null,
        })
        mockApi.getProjects.mockResolvedValue({
            results: [{ id: 'proj-1', name: 'Work' }],
            nextCursor: null,
        })

        await program.parseAsync(['node', 'td', 'upcoming'])

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Task in range'))
        expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Task out of range'))
    })

    it('accepts custom days argument', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({
            results: [
                {
                    id: 'task-1',
                    content: 'Task day 2',
                    projectId: 'proj-1',
                    due: { date: getDateOffset(2) },
                },
            ],
            nextCursor: null,
        })
        mockApi.getProjects.mockResolvedValue({
            results: [{ id: 'proj-1', name: 'Work' }],
            nextCursor: null,
        })

        await program.parseAsync(['node', 'td', 'upcoming', '3'])

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Task day 2'))
        expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Task day 5'))
    })

    it('always includes overdue tasks', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({
            results: [
                {
                    id: 'task-1',
                    content: 'Overdue task',
                    projectId: 'proj-1',
                    due: { date: getDateOffset(-2) },
                },
            ],
            nextCursor: null,
        })
        mockApi.getProjects.mockResolvedValue({
            results: [{ id: 'proj-1', name: 'Work' }],
            nextCursor: null,
        })

        await program.parseAsync(['node', 'td', 'upcoming', '3'])

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Overdue'))
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Overdue task'))
    })

    it('shows Today header for today tasks', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({
            results: [
                {
                    id: 'task-1',
                    content: 'Today task',
                    projectId: 'proj-1',
                    due: { date: getDateOffset(0) },
                },
            ],
            nextCursor: null,
        })
        mockApi.getProjects.mockResolvedValue({
            results: [{ id: 'proj-1', name: 'Work' }],
            nextCursor: null,
        })

        await program.parseAsync(['node', 'td', 'upcoming'])

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Today'))
    })

    it('shows Tomorrow header for tomorrow tasks', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({
            results: [
                {
                    id: 'task-1',
                    content: 'Tomorrow task',
                    projectId: 'proj-1',
                    due: { date: getDateOffset(1) },
                },
            ],
            nextCursor: null,
        })
        mockApi.getProjects.mockResolvedValue({
            results: [{ id: 'proj-1', name: 'Work' }],
            nextCursor: null,
        })

        await program.parseAsync(['node', 'td', 'upcoming'])

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Tomorrow'))
    })

    it('shows empty message when no tasks', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({ results: [], nextCursor: null })
        mockApi.getProjects.mockResolvedValue({ results: [], nextCursor: null })

        await program.parseAsync(['node', 'td', 'upcoming'])

        expect(consoleSpy).toHaveBeenCalledWith('No tasks due in the next 7 days.')
    })

    it('shows singular "day" for 1 day', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({ results: [], nextCursor: null })
        mockApi.getProjects.mockResolvedValue({ results: [], nextCursor: null })

        await program.parseAsync(['node', 'td', 'upcoming', '1'])

        expect(consoleSpy).toHaveBeenCalledWith('No tasks due in the next 1 day.')
    })

    it('outputs JSON with --json flag', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({
            results: [
                {
                    id: 'task-1',
                    content: 'Task',
                    projectId: 'proj-1',
                    due: { date: getDateOffset(1) },
                },
            ],
            nextCursor: null,
        })

        await program.parseAsync(['node', 'td', 'upcoming', '--json'])

        const output = consoleSpy.mock.calls[0][0]
        const parsed = JSON.parse(output)
        expect(parsed.results).toBeDefined()
        expect(parsed.results[0].content).toBe('Task')
    })

    it('outputs NDJSON with --ndjson flag', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({
            results: [
                {
                    id: 'task-1',
                    content: 'Task 1',
                    projectId: 'proj-1',
                    due: { date: getDateOffset(0) },
                },
                {
                    id: 'task-2',
                    content: 'Task 2',
                    projectId: 'proj-1',
                    due: { date: getDateOffset(1) },
                },
            ],
            nextCursor: null,
        })

        await program.parseAsync(['node', 'td', 'upcoming', '--ndjson'])

        const output = consoleSpy.mock.calls[0][0]
        const lines = output.split('\n')
        expect(lines).toHaveLength(2)
    })

    it('groups tasks by date with counts', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({
            results: [
                {
                    id: 'task-1',
                    content: 'Task 1',
                    projectId: 'proj-1',
                    due: { date: getDateOffset(0) },
                },
                {
                    id: 'task-2',
                    content: 'Task 2',
                    projectId: 'proj-1',
                    due: { date: getDateOffset(0) },
                },
            ],
            nextCursor: null,
        })
        mockApi.getProjects.mockResolvedValue({
            results: [{ id: 'proj-1', name: 'Work' }],
            nextCursor: null,
        })

        await program.parseAsync(['node', 'td', 'upcoming'])

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Today (2)'))
    })

    it('groups tasks with different times on the same day under one heading', async () => {
        const program = createProgram()
        const tomorrow = getDateOffset(1)

        mockApi.getTasksByFilter.mockResolvedValue({
            results: [
                {
                    id: 'task-1',
                    content: 'All-day task',
                    projectId: 'proj-1',
                    due: { date: tomorrow },
                },
                {
                    id: 'task-2',
                    content: 'Morning task',
                    projectId: 'proj-1',
                    due: { date: `${tomorrow}T09:00:00` },
                },
                {
                    id: 'task-3',
                    content: 'Evening task',
                    projectId: 'proj-1',
                    due: { date: `${tomorrow}T18:00:00` },
                },
            ],
            nextCursor: null,
        })
        mockApi.getProjects.mockResolvedValue({
            results: [{ id: 'proj-1', name: 'Work' }],
            nextCursor: null,
        })

        await program.parseAsync(['node', 'td', 'upcoming'])

        const headings = consoleSpy.mock.calls
            .map((call: unknown[]) => String(call[0]))
            .filter((line: string) => line.startsWith('Tomorrow'))
        expect(headings).toEqual(['Tomorrow (3)'])
    })

    it("lists each day's tasks in time order, all-day tasks first", async () => {
        // The API returns tasks in the order they were created, not by due time.
        const program = createProgram()
        const tomorrow = getDateOffset(1)

        mockApi.getTasksByFilter.mockResolvedValue({
            results: [
                {
                    id: 'task-1',
                    content: 'Evening task',
                    projectId: 'proj-1',
                    due: { date: `${tomorrow}T18:00:00` },
                },
                {
                    id: 'task-2',
                    content: 'Morning task',
                    projectId: 'proj-1',
                    due: { date: `${tomorrow}T09:00:00` },
                },
                {
                    id: 'task-3',
                    content: 'All-day task',
                    projectId: 'proj-1',
                    due: { date: tomorrow },
                },
            ],
            nextCursor: null,
        })
        mockApi.getProjects.mockResolvedValue({
            results: [{ id: 'proj-1', name: 'Work' }],
            nextCursor: null,
        })

        await program.parseAsync(['node', 'td', 'upcoming'])

        const lines = consoleSpy.mock.calls
            .map((call: unknown[]) => String(call[0]).split('\n')[0].trim())
            .filter((line: string) => line.startsWith('Tomorrow') || line.endsWith(' task'))
        expect(lines).toEqual(['Tomorrow (3)', 'All-day task', 'Morning task', 'Evening task'])
    })

    describe("the account's day", () => {
        afterEach(() => {
            vi.useRealTimers()
        })

        it("dates the headings by the account's today when the machine is a day ahead", async () => {
            // 03:00 UTC on 25 November is still 9 PM on the 24th for an account in Chicago.
            vi.useFakeTimers({ toFake: ['Date'] })
            vi.setSystemTime(new Date('2026-11-25T03:00:00Z'))
            vi.mocked(getAccountTimezone).mockResolvedValueOnce('America/Chicago')
            mockApi.getTasksByFilter.mockResolvedValue({
                results: [
                    {
                        id: 'task-1',
                        content: 'All-day task today',
                        projectId: 'proj-1',
                        due: { date: '2026-11-24' },
                    },
                    {
                        // 02:00 UTC on the 25th is 8 PM on the 24th in Chicago.
                        id: 'task-2',
                        content: 'Fixed-time task today',
                        projectId: 'proj-1',
                        due: { date: '2026-11-25T02:00:00Z' },
                    },
                    {
                        id: 'task-3',
                        content: 'All-day task tomorrow',
                        projectId: 'proj-1',
                        due: { date: '2026-11-25' },
                    },
                ],
                nextCursor: null,
            })
            mockApi.getProjects.mockResolvedValue({
                results: [{ id: 'proj-1', name: 'Work' }],
                nextCursor: null,
            })

            await createProgram().parseAsync(['node', 'td', 'upcoming'])

            const lines = consoleSpy.mock.calls
                .map((call: unknown[]) => String(call[0]).split('\n')[0].trim())
                .filter((line: string) => /^(Overdue|Today|Tomorrow) \(|task/.test(line))
            expect(lines).toEqual([
                'Today (2)',
                'All-day task today',
                'Fixed-time task today',
                'Tomorrow (1)',
                'All-day task tomorrow',
            ])
        })
    })

    describe('order', () => {
        // The API returns tasks in the order they were created.
        const tasksInCreationOrder = [
            {
                id: 'task-1',
                content: 'Plain task tomorrow',
                projectId: 'proj-1',
                priority: 1,
                due: { date: '2026-11-25' },
            },
            {
                id: 'task-2',
                content: 'Urgent task tomorrow',
                projectId: 'proj-1',
                priority: 4,
                due: { date: '2026-11-25' },
            },
            {
                id: 'task-3',
                content: 'Evening task today',
                projectId: 'proj-1',
                priority: 1,
                due: { date: '2026-11-24T18:00:00' },
            },
            {
                id: 'task-4',
                content: 'Morning task today',
                projectId: 'proj-1',
                priority: 1,
                due: { date: '2026-11-24T09:00:00' },
            },
            {
                id: 'task-5',
                content: 'Recent overdue task',
                projectId: 'proj-1',
                priority: 1,
                due: { date: '2026-11-23' },
            },
            {
                id: 'task-6',
                content: 'Old overdue task',
                projectId: 'proj-1',
                priority: 1,
                due: { date: '2026-11-20' },
            },
        ]

        beforeEach(() => {
            vi.useFakeTimers({ toFake: ['Date'] })
            vi.setSystemTime(new Date('2026-11-24T12:00:00Z'))
            mockApi.getTasksByFilter.mockResolvedValue({
                results: tasksInCreationOrder,
                nextCursor: null,
            })
            mockApi.getProjects.mockResolvedValue({
                results: [{ id: 'proj-1', name: 'Work' }],
                nextCursor: null,
            })
        })

        afterEach(() => {
            vi.useRealTimers()
        })

        it('lists each section the way the Todoist apps do: oldest first, all-day before timed, then priority', async () => {
            await createProgram().parseAsync(['node', 'td', 'upcoming'])

            const lines = consoleSpy.mock.calls
                .map((call: unknown[]) => String(call[0]).split('\n')[0].trim())
                .filter((line: string) => /^(Overdue|Today|Tomorrow) \(|task/.test(line))
            expect(lines).toEqual([
                'Overdue (2)',
                'Old overdue task',
                'Recent overdue task',
                'Today (2)',
                'Morning task today',
                'Evening task today',
                'Tomorrow (2)',
                'Urgent task tomorrow',
                'Plain task tomorrow',
            ])
        })

        it("orders fixed and floating times by the account's clock", async () => {
            // For an account in Tokyo, 23:00 UTC on the 24th is 8 AM on the 25th: after a
            // floating 7 AM on the 25th, and after the 25th's all-day task. The machine is on UTC.
            vi.mocked(getAccountTimezone).mockResolvedValueOnce('Asia/Tokyo')
            mockApi.getTasksByFilter.mockResolvedValue({
                results: [
                    {
                        id: 'task-1',
                        content: 'Fixed 8 AM task',
                        projectId: 'proj-1',
                        priority: 1,
                        due: { date: '2026-11-24T23:00:00Z' },
                    },
                    {
                        id: 'task-2',
                        content: 'Floating 7 AM task',
                        projectId: 'proj-1',
                        priority: 1,
                        due: { date: '2026-11-25T07:00:00' },
                    },
                    {
                        id: 'task-3',
                        content: 'All-day task',
                        projectId: 'proj-1',
                        priority: 1,
                        due: { date: '2026-11-25' },
                    },
                ],
                nextCursor: null,
            })

            await createProgram().parseAsync(['node', 'td', 'upcoming', '--json'])

            const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0]))
            expect(parsed.results.map((task: { id: string }) => task.id)).toEqual([
                'task-3',
                'task-2',
                'task-1',
            ])
        })

        it('uses the same order for --json', async () => {
            await createProgram().parseAsync(['node', 'td', 'upcoming', '--json'])

            const parsed = JSON.parse(String(consoleSpy.mock.calls[0][0]))
            expect(parsed.results.map((task: { id: string }) => task.id)).toEqual([
                'task-6',
                'task-5',
                'task-4',
                'task-3',
                'task-2',
                'task-1',
            ])
        })
    })

    it('rejects invalid days argument', async () => {
        const program = createProgram()
        const errorSpy = captureConsole('error')

        await program.parseAsync(['node', 'td', 'upcoming', 'invalid'])

        expect(errorSpy).toHaveBeenCalledWith('Days must be a positive number')
    })

    it('uses server-side assignee scoping by default', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({ results: [], nextCursor: null })
        mockApi.getProjects.mockResolvedValue({ results: [], nextCursor: null })

        await program.parseAsync(['node', 'td', 'upcoming'])

        expect(mockApi.getTasksByFilter).toHaveBeenCalledWith(
            expect.objectContaining({
                query: '(due before: 7 days) & (assigned to: me | !assigned)',
            }),
        )
    })

    it('uses broad query with --any-assignee', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({ results: [], nextCursor: null })
        mockApi.getProjects.mockResolvedValue({ results: [], nextCursor: null })

        await program.parseAsync(['node', 'td', 'upcoming', '--any-assignee'])

        expect(mockApi.getTasksByFilter).toHaveBeenCalledWith(
            expect.objectContaining({
                query: 'due before: 7 days',
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
                    due: { date: getDateOffset(1) },
                },
                {
                    id: 'task-2',
                    content: 'Other task',
                    projectId: 'proj-1',
                    responsibleUid: 'other-user-456',
                    due: { date: getDateOffset(1) },
                },
            ],
            nextCursor: null,
        })
        mockApi.getProjects.mockResolvedValue({
            results: [{ id: 'proj-1', name: 'Work' }],
            nextCursor: null,
        })

        await program.parseAsync(['node', 'td', 'upcoming', '--any-assignee'])

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('My task'))
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Other task'))
    })

    it('uses custom days in server-side scoped query', async () => {
        const program = createProgram()

        mockApi.getTasksByFilter.mockResolvedValue({ results: [], nextCursor: null })
        mockApi.getProjects.mockResolvedValue({ results: [], nextCursor: null })

        await program.parseAsync(['node', 'td', 'upcoming', '14'])

        expect(mockApi.getTasksByFilter).toHaveBeenCalledWith(
            expect.objectContaining({
                query: '(due before: 14 days) & (assigned to: me | !assigned)',
            }),
        )
    })
})
