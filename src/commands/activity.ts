import { resolveOutputMode } from '@todoist/cli-core'
import {
    formatUserShortName,
    isWorkspaceProject,
    type ActivityEvent,
    type ActivityObjectEventType,
} from '@todoist/sdk'
import chalk from 'chalk'
import { Command, Option } from 'commander'
import { getAccountTimezone, getApi, getCurrentUserId, type Project } from '../lib/api/core.js'
import { withCaseInsensitiveChoices } from '../lib/completion.js'
import { CURSOR_DESCRIPTION } from '../lib/constants.js'
import { addDays, parseDateOption, startOfDayInTimezone, toApiInstant } from '../lib/dates.js'
import { CliError } from '../lib/errors.js'
import type { Pagination } from '../lib/options.js'
import { formatPaginatedJson, formatPaginatedNdjson } from '../lib/output.js'
import { paginate } from '../lib/pagination.js'
import { extractId, isIdRef, resolveProjectRef } from '../lib/refs.js'
import { truncateForDisplay } from '../lib/text.js'

interface ActivityOptions extends Pagination {
    since?: string
    until?: string
    type?: string
    event?: string
    project?: string
    by?: string
    json?: boolean
    ndjson?: boolean
    full?: boolean
}

const ACTIVITY_LIMIT = 100

const EVENT_COLORS: Record<string, (s: string) => string> = {
    added: chalk.green,
    completed: chalk.green,
    updated: chalk.yellow,
    deleted: chalk.red,
    uncompleted: chalk.yellow,
    archived: chalk.gray,
    unarchived: chalk.cyan,
    shared: chalk.magenta,
    left: chalk.gray,
    reordered: chalk.cyan,
    moved: chalk.cyan,
}

const OBJECT_TYPE_LABELS: Record<string, string> = {
    task: 'task',
    item: 'task',
    comment: 'comment',
    note: 'comment',
    project: 'project',
}

const EVENT_CHOICES = Object.keys(EVENT_COLORS)
const OBJECT_TYPE_CHOICES = [...new Set(Object.values(OBJECT_TYPE_LABELS))]

function formatEventType(eventType: string): string {
    const colorFn = EVENT_COLORS[eventType] || chalk.white
    return colorFn(eventType.padEnd(11))
}

function formatObjectType(objectType: string): string {
    const label = OBJECT_TYPE_LABELS[objectType] || objectType
    return chalk.dim(label.padEnd(8))
}

function formatEventDate(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    return chalk.dim(`${month}-${day} ${hours}:${minutes}`)
}

function getEventContent(event: ActivityEvent): string {
    const extra = event.extraData as Record<string, unknown> | null

    if (extra?.content) {
        return String(extra.content)
    }
    if (extra?.name) {
        return String(extra.name)
    }
    if (extra?.last_content) {
        return String(extra.last_content)
    }
    if (extra?.last_name) {
        return String(extra.last_name)
    }

    return `id:${event.objectId}`
}

function truncateContent(content: string, maxLength = 100): string {
    const firstLine = content.split('\n')[0]
    // Unlike the comment previews, the ellipsis counts toward `maxLength` here,
    // so the helper's budget is three short of it. The outer check stays in code
    // units: it only decides WHETHER to cut, never where, so it cannot split a pair.
    return firstLine.length <= maxLength ? firstLine : truncateForDisplay(firstLine, maxLength - 3)
}

function formatActivityRow(
    event: ActivityEvent,
    projectName?: string,
    initiatorName?: string | null,
    showInitiator = false,
): string {
    const date = formatEventDate(event.eventDate)
    const eventType = formatEventType(event.eventType)
    const objectType = formatObjectType(event.objectType)
    const content = getEventContent(event)

    const metaParts = [date, eventType, objectType]
    if (projectName) {
        metaParts.push(chalk.cyan(projectName))
    }
    if (showInitiator && initiatorName) {
        metaParts.push(chalk.magenta(`by ${initiatorName}`))
    }

    const line1 = `  ${metaParts.join('  ')}`
    const line2 = `    ${truncateContent(content)}`

    return `${line1}\n${line2}`
}

// The API refuses a range longer than this.
const MAX_RANGE_DAYS = 365
const DAY_MS = 24 * 60 * 60 * 1000

/** Checks `--since` and `--until` are dates, in order, before any request is made. */
function checkDateFlags(since: string | undefined, until: string | undefined): void {
    if (since) parseDateOption(since, '--since')
    if (until) parseDateOption(until, '--until')
    if (since && until && until < since) {
        throw new CliError('INVALID_DATE_RANGE', '--until must not be before --since', [
            `Received --since ${since} --until ${until}`,
        ])
    }
}

/**
 * The instants `--since` and `--until` cover: whole days in the account's `timezone`, from the
 * start of the `--since` day to the end of the `--until` day. The API reads a bare date as UTC
 * midnight and leaves out `date_to` itself, so the days are sent as instants.
 */
function dateRangeIn(
    since: string | undefined,
    until: string | undefined,
    timezone: string | undefined,
): { dateFrom?: string; dateTo?: string } {
    const from = since ? startOfDayInTimezone(since, timezone) : undefined
    const to = until ? startOfDayInTimezone(addDays(until, 1), timezone) : undefined
    if (from && to && until && to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
        throw new CliError('INVALID_DATE_RANGE', 'Activity date ranges cannot exceed 365 days', [
            `Split the range, for example --since ${addDays(until, -363)} --until ${until} for the most recent part.`,
        ])
    }
    return {
        dateFrom: from && toApiInstant(from),
        dateTo: to && toApiInstant(to),
    }
}

export function registerActivityCommand(program: Command): void {
    program
        .command('activity')
        .description('View activity logs')
        .option('--since <date>', 'First day to include (YYYY-MM-DD, in your Todoist time zone)')
        .option('--until <date>', 'Last day to include (YYYY-MM-DD, in your Todoist time zone)')
        .addOption(
            withCaseInsensitiveChoices(
                new Option('--type <type>', 'Filter by object type (task, comment, project)'),
                OBJECT_TYPE_CHOICES,
            ),
        )
        .addOption(
            withCaseInsensitiveChoices(
                new Option('--event <type>', 'Filter by event type'),
                EVENT_CHOICES,
            ),
        )
        .option('--project <name>', 'Filter by project')
        .option('--by <user>', 'Filter by initiator (use "me" for yourself)')
        .option('--limit <n>', `Limit results (default: ${ACTIVITY_LIMIT})`)
        .option('--cursor <cursor>', CURSOR_DESCRIPTION)
        .option('--json', 'Output as JSON')
        .option('--ndjson', 'Output as newline-delimited JSON')
        .option('--full', 'Include all fields in JSON output')
        .action(async (options: ActivityOptions) => {
            const outputMode = resolveOutputMode(options)

            checkDateFlags(options.since, options.until)
            // Days are the account's, so look its time zone up alongside the other lookups.
            // It never rejects: a failed lookup falls back to the machine's zone.
            const timezone =
                options.since || options.until ? getAccountTimezone() : Promise.resolve(undefined)

            const api = await getApi()

            const project = options.project
                ? await resolveProjectRef(api, options.project, { includeUnjoined: true })
                : undefined
            const projectId = project?.id

            let initiatorId: string | undefined
            if (options.by) {
                if (options.by.toLowerCase() === 'me') {
                    initiatorId = await getCurrentUserId()
                } else if (isIdRef(options.by)) {
                    initiatorId = extractId(options.by)
                } else {
                    initiatorId = options.by
                }
            }

            const { dateFrom, dateTo } = dateRangeIn(options.since, options.until, await timezone)

            const targetLimit = options.limit ? parseInt(options.limit, 10) : ACTIVITY_LIMIT

            const { results: events, nextCursor } = await paginate(
                async (cursor, limit) => {
                    const objectEventTypes: ActivityObjectEventType | undefined =
                        options.type || options.event
                            ? (`${options.type ?? ''}:${options.event ?? ''}` as ActivityObjectEventType)
                            : undefined
                    const resp = await api.getActivityLogs({
                        dateFrom,
                        dateTo,
                        objectEventTypes,
                        parentProjectId: projectId,
                        initiatorId,
                        cursor: cursor ?? undefined,
                        limit,
                    })
                    return { results: resp.results, nextCursor: resp.nextCursor }
                },
                { limit: targetLimit, startCursor: options.cursor },
            )

            if (outputMode === 'json') {
                console.log(
                    formatPaginatedJson({ results: events, nextCursor }, undefined, options.full),
                )
                return
            }

            if (outputMode === 'ndjson') {
                console.log(
                    formatPaginatedNdjson({ results: events, nextCursor }, undefined, options.full),
                )
                return
            }

            if (events.length === 0) {
                console.log('No activity found.')
                if (nextCursor) {
                    console.log(
                        chalk.dim(
                            '\n... more items exist. Use --cursor to paginate, or narrow results with --since/--until.',
                        ),
                    )
                }
                return
            }

            const { results: allProjects } = await api.getProjects()
            const projects = new Map<string, Project>(allProjects.map((p) => [p.id, p]))
            // A workspace project the user hasn't joined isn't in their project list.
            if (project) projects.set(project.id, project)

            const workspaceIds = new Set<string>()
            for (const event of events) {
                if (!event.parentProjectId) continue
                const proj = projects.get(event.parentProjectId)
                if (proj && isWorkspaceProject(proj)) {
                    workspaceIds.add(proj.workspaceId)
                }
            }

            const userNames = new Map<string, string>()
            for (const wsId of workspaceIds) {
                let cursor: string | undefined
                while (true) {
                    const response = await api.getWorkspaceUsers({
                        workspaceId: wsId,
                        cursor,
                        limit: 200,
                    })
                    for (const user of response.workspaceUsers) {
                        userNames.set(user.userId, user.fullName)
                    }
                    if (!response.hasMore || !response.nextCursor) break
                    cursor = response.nextCursor
                }
            }

            console.log(chalk.bold(`Activity (${events.length})`))
            console.log('')

            for (const event of events) {
                const projectName = event.parentProjectId
                    ? projects.get(event.parentProjectId)?.name
                    : undefined

                let initiatorName: string | null = null
                if (event.initiatorId && userNames.size > 0) {
                    const fullName = userNames.get(event.initiatorId)
                    if (fullName) {
                        initiatorName = formatUserShortName(fullName)
                    }
                }

                console.log(
                    formatActivityRow(event, projectName, initiatorName, userNames.size > 0),
                )
                console.log('')
            }

            if (nextCursor) {
                console.log(
                    chalk.dim(
                        '\n... more items exist. Use --cursor to paginate, or narrow results with --since/--until.',
                    ),
                )
            }
        })
}
