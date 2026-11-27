import { addDays as addCalendarDays } from 'date-fns/addDays'
import { format } from 'date-fns/format'
import { parseISO } from 'date-fns/parseISO'
import { CliError } from './errors.js'

const TODOIST_FIXED_OFFSET = /^GMT ([+-])(\d{1,2}):(\d{2})$/

/**
 * A Todoist account can use a fixed offset named like `GMT -6:00` or `GMT +5:30`. `Intl`
 * rejects that name, but accepts the same offset written as `-06:00`, so this rewrites it.
 * Any other name comes back as it is.
 */
export function toIntlTimeZone(timeZone: string): string {
    const match = TODOIST_FIXED_OFFSET.exec(timeZone)
    if (!match) return timeZone
    const [, sign, hours, minutes] = match
    return `${sign}${hours.padStart(2, '0')}:${minutes}`
}

const FORMAT_OPTIONS = {
    day: { year: 'numeric', month: '2-digit', day: '2-digit' },
    wallClock: {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    },
    dateTime: {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>

// Formatters by kind and time zone, built once each: commands format a day for every task they
// list. `null` marks a name `Intl` rejected. The machine's own zone is not cached, since its
// formatter would go stale if the process's `TZ` changed.
const formatters = new Map<string, Intl.DateTimeFormat | null>()

function formatterIn(
    timeZone: string | undefined,
    kind: keyof typeof FORMAT_OPTIONS,
): Intl.DateTimeFormat {
    const options = FORMAT_OPTIONS[kind]
    if (timeZone) {
        const key = `${kind} ${timeZone}`
        let formatter = formatters.get(key)
        if (formatter === undefined) {
            try {
                formatter = new Intl.DateTimeFormat('en-US', {
                    ...options,
                    timeZone: toIntlTimeZone(timeZone),
                })
            } catch (error) {
                // A name `Intl` does not know falls back to the machine's time zone.
                if (!(error instanceof RangeError)) throw error
                formatter = null
            }
            formatters.set(key, formatter)
        }
        if (formatter) return formatter
    }
    return new Intl.DateTimeFormat('en-US', options)
}

/**
 * The calendar day an instant falls on in `timeZone`, as `YYYY-MM-DD`. Takes an IANA name or a
 * Todoist fixed offset such as `GMT -6:00`. Without a time zone, or with one `Intl` does not
 * know, the machine's is used.
 */
export function formatDateInTimezone(date: Date, timeZone?: string): string {
    const parts = formatterIn(timeZone, 'day').formatToParts(date)
    const part = (type: Intl.DateTimeFormatPartTypes) =>
        parts.find((p) => p.type === type)?.value ?? ''
    return `${part('year')}-${part('month')}-${part('day')}`
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Checks a `--since` / `--until` flag value is a real calendar date written as `YYYY-MM-DD`,
 * and returns that day's UTC midnight as a timestamp. Throws `INVALID_DATE` otherwise.
 */
export function parseDateOption(value: string, option: '--since' | '--until'): number {
    const match = DATE_PATTERN.exec(value)
    if (!match) {
        throw new CliError('INVALID_DATE', `Invalid ${option} date: "${value}"`, [
            `Use YYYY-MM-DD format, for example: ${option} 2026-08-07`,
        ])
    }

    const [, yearString, monthString, dayString] = match
    const year = Number(yearString)
    const month = Number(monthString)
    const day = Number(dayString)
    const timestamp = Date.UTC(year, month - 1, day)
    const parsed = new Date(timestamp)

    if (
        parsed.getUTCFullYear() !== year ||
        parsed.getUTCMonth() !== month - 1 ||
        parsed.getUTCDate() !== day
    ) {
        throw new CliError('INVALID_DATE', `Invalid ${option} date: "${value}"`, [
            `Use a valid calendar date in YYYY-MM-DD format`,
        ])
    }

    return timestamp
}

// A time with `Z` or an offset is a fixed instant; without one it is a floating wall-clock time.
const FIXED_INSTANT = /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i

/**
 * The `YYYY-MM-DD` day a task's `due.date` falls on for the account, given the account's
 * `timeZone`. A date, or a floating time such as `2026-01-29T18:00:00`, is already on the
 * account's clock, so its own date is the day. A fixed time such as `2026-01-29T02:00:00Z` is an
 * instant, placed on the day it falls on in `timeZone`.
 */
export function dueDateDay(dueDate: string, timeZone?: string): string {
    if (FIXED_INSTANT.test(dueDate)) return formatDateInTimezone(new Date(dueDate), timeZone)
    return dueDate.slice(0, 10)
}

const HOUR_MS = 60 * 60 * 1000

/** How far `timeZone`'s clock is ahead of UTC at `instant`, in milliseconds. */
function offsetAt(instant: number, timeZone: string | undefined): number {
    const parts = formatterIn(timeZone, 'wallClock').formatToParts(new Date(instant))
    const part = (type: Intl.DateTimeFormatPartTypes) =>
        Number(parts.find((p) => p.type === type)?.value)
    const wallClockAsUtc = Date.UTC(
        part('year'),
        part('month') - 1,
        part('day'),
        part('hour'),
        part('minute'),
        part('second'),
    )
    return wallClockAsUtc - (instant - (((instant % 1000) + 1000) % 1000))
}

/**
 * The instant `day` (`YYYY-MM-DD`) begins in `timeZone` (an IANA name or a Todoist fixed
 * offset): its midnight, or the first moment that exists on a day whose midnight a clock change
 * skips. Without a time zone, or with one `Intl` does not know, the machine's is used.
 */
export function startOfDayInTimezone(day: string, timeZone?: string): Date {
    const previousDay = addDays(day, -1)
    const [year, month, date] = day.split('-').map(Number)
    const midnightAsUtc = Date.UTC(year, month - 1, date)
    // A clock change near midnight gives the day's start one of the offsets in force a day either
    // side of it. Of the instants those offsets give, the start is the one on `day` whose moment
    // before is still on the day before.
    const starts = [-24, 0, 24]
        .map((hours) => midnightAsUtc - offsetAt(midnightAsUtc + hours * HOUR_MS, timeZone))
        .filter(
            (instant) =>
                formatDateInTimezone(new Date(instant), timeZone) === day &&
                formatDateInTimezone(new Date(instant - 1), timeZone) === previousDay,
        )
    return new Date(
        starts.length > 0 ? Math.min(...starts) : midnightAsUtc - offsetAt(midnightAsUtc, timeZone),
    )
}

/** The `YYYY-MM-DD` day `days` calendar days after `day`, or before it when `days` is negative. */
export function addDays(day: string, days: number): string {
    return format(addCalendarDays(parseISO(day), days), 'yyyy-MM-dd')
}

/**
 * The heading for a `YYYY-MM-DD` day in a list of tasks: `Overdue`, `Today`, `Tomorrow`, or the
 * date such as `Feb 3`. `today` is the account's today.
 */
export function formatDateHeader(day: string, today: string): string {
    if (day < today) return 'Overdue'
    if (day === today) return 'Today'
    if (day === addDays(today, 1)) return 'Tomorrow'
    const [year, month, date] = day.split('-').map(Number)
    return new Date(year, month - 1, date).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
    })
}

const MINUTE_MS = 60_000

// The real range of UTC offsets, -12:00 to +14:00; anything wider is a typo such as +20:00 for +02:00.
const MIN_OFFSET_MINUTES = -12 * 60
const MAX_OFFSET_MINUTES = 14 * 60

const ISO_LOCAL =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/i

/**
 * Parses `YYYY-MM-DD` or `YYYY-MM-DD[T ]HH:MM[:SS[.fraction]]` with an optional `Z` or `+HH:MM`
 * offset, which includes everything `Date.toISOString()` produces.
 * Without an offset the value is local time, date-only included (unlike `new Date('2026-10-20')`,
 * which is UTC). Returns `null` for anything else, including calendar dates that `Date` would
 * silently roll over such as `2026-02-30`.
 */
export function parseLocalDate(value: string): Date | null {
    const match = ISO_LOCAL.exec(value.trim())
    if (!match) return null
    const [, year, month, day, hour, minute, second, fraction, zone] = match
    if (hour === undefined && zone !== undefined) return null

    const [y, mo, d, h, mi, s] = [year, month, day, hour ?? '0', minute ?? '0', second ?? '0'].map(
        Number,
    )
    const ms = Number((fraction ?? '').padEnd(3, '0').slice(0, 3))
    if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null

    if (zone === undefined) {
        const local = new Date(y, mo - 1, d, h, mi, s, ms)
        // `new Date(y, ...)` maps the years 0 to 99 to 1900 to 1999, and rolls an impossible day over.
        if (local.getFullYear() !== y || local.getMonth() !== mo - 1 || local.getDate() !== d) {
            return null
        }
        // A time typed inside a daylight-saving gap does not exist and `Date` shifts it to the next
        // hour. A date with no time is exempt: where midnight is skipped it is the first instant
        // of that day, which is what "until that day" means.
        const typedTimeExists =
            hour === undefined ||
            (local.getHours() === h && local.getMinutes() === mi && local.getSeconds() === s)
        return typedTimeExists ? local : null
    }

    const utc = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms))
    if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d) {
        return null
    }
    if (zone.toUpperCase() === 'Z') return utc
    const digits = zone.slice(1).replace(':', '')
    const offsetMinutes =
        (zone.startsWith('-') ? -1 : 1) *
        (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)))
    if (
        Number(digits.slice(2)) > 59 ||
        offsetMinutes < MIN_OFFSET_MINUTES ||
        offsetMinutes > MAX_OFFSET_MINUTES
    ) {
        return null
    }
    return new Date(utc.getTime() - offsetMinutes * MINUTE_MS)
}

/**
 * A date and time for people to read, such as `Jan 8, 2026, 8:00 PM`, in `timeZone` (an IANA
 * name or a Todoist fixed offset). Without a time zone, or with one `Intl` does not know, the
 * machine's is used.
 */
export function formatDateTime(date: Date, timeZone?: string): string {
    return formatterIn(timeZone, 'dateTime').format(date)
}
