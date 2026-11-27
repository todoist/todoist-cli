import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
    addDays,
    dueDateDay,
    formatDateHeader,
    formatDateInTimezone,
    formatDateTime,
    parseLocalDate,
} from './dates.js'

describe('addDays', () => {
    it.each([
        ['the next day', '2026-01-29', 1, '2026-01-30'],
        ['across the end of a month', '2026-01-31', 1, '2026-02-01'],
        ['across the end of a year', '2026-12-31', 1, '2027-01-01'],
        ['onto a leap day', '2028-02-28', 1, '2028-02-29'],
        ['back across the start of a month', '2026-03-01', -1, '2026-02-28'],
        ['a week on', '2026-01-29', 7, '2026-02-05'],
    ])('counts %s', (_, day, days, expected) => {
        expect(addDays(day, days)).toBe(expected)
    })
})

describe('formatDateHeader', () => {
    const today = '2026-01-29'

    it.each([
        { day: '2026-01-28', expected: 'Overdue', description: 'yesterday' },
        { day: '2026-01-22', expected: 'Overdue', description: 'last week' },
        { day: '2020-01-01', expected: 'Overdue', description: 'an old date' },
        { day: '2026-01-29', expected: 'Today', description: 'today' },
        { day: '2026-01-30', expected: 'Tomorrow', description: 'tomorrow' },
        { day: '2026-02-03', expected: 'Feb 3', description: 'a later day' },
    ])('returns "$expected" for $description', ({ day, expected }) => {
        expect(formatDateHeader(day, today)).toBe(expected)
    })

    it('counts tomorrow from the today it is given, across the end of a year', () => {
        expect(formatDateHeader('2027-01-01', '2026-12-31')).toBe('Tomorrow')
    })
})

describe('dueDateDay', () => {
    it.each([
        ['a date', '2026-01-29'],
        ['a floating time', '2026-01-29T18:00:00'],
        ['a floating midnight', '2026-01-29T00:00:00'],
        ['a floating time just before midnight', '2026-01-29T23:59:59'],
        ['a floating time with fractional seconds', '2026-01-29T09:30:00.000000'],
    ])("keeps %s on its own day, whatever the account's time zone", (_, dueDate) => {
        expect(dueDateDay(dueDate, 'Asia/Tokyo')).toBe('2026-01-29')
        expect(dueDateDay(dueDate, 'America/Chicago')).toBe('2026-01-29')
        expect(dueDateDay(dueDate)).toBe('2026-01-29')
    })

    it("places a fixed time on the day it falls on in the account's time zone", () => {
        // 02:00 UTC on 29 January is 8 PM on the 28th in Chicago and 11 AM on the 29th in Tokyo.
        expect(dueDateDay('2026-01-29T02:00:00Z', 'America/Chicago')).toBe('2026-01-28')
        expect(dueDateDay('2026-01-29T02:00:00Z', 'Asia/Tokyo')).toBe('2026-01-29')
        expect(dueDateDay('2026-01-29T02:00:00.000000Z', '-06:00')).toBe('2026-01-28')
    })

    it("places a fixed time on the machine's day when no time zone is given", () => {
        // The test run pins the machine's time zone to UTC.
        expect(dueDateDay('2026-01-28T23:30:00Z')).toBe('2026-01-28')
    })
})

describe('parseLocalDate', () => {
    it.each([
        ['2026-10-20', new Date(2026, 9, 20)],
        ['2026-10-20T09:30', new Date(2026, 9, 20, 9, 30)],
        ['2026-10-20 09:30', new Date(2026, 9, 20, 9, 30)],
        ['2026-10-20T09:30:15', new Date(2026, 9, 20, 9, 30, 15)],
        ['2026-10-20T09:30Z', new Date(Date.UTC(2026, 9, 20, 9, 30))],
        ['2026-10-20t09:30z', new Date(Date.UTC(2026, 9, 20, 9, 30))],
        ['2026-10-20T09:30+02:00', new Date(Date.UTC(2026, 9, 20, 7, 30))],
        ['2026-10-20T09:30-0530', new Date(Date.UTC(2026, 9, 20, 15, 0))],
        ['2026-10-20T09:30+14:00', new Date(Date.UTC(2026, 9, 19, 19, 30))],
        ['2026-10-20T09:30-12:00', new Date(Date.UTC(2026, 9, 20, 21, 30))],
        ['2026-10-20T09:30+00:00', new Date(Date.UTC(2026, 9, 20, 9, 30))],
        ['2026-10-20T09:00:00.000Z', new Date(Date.UTC(2026, 9, 20, 9, 0, 0, 0))],
        ['2026-10-20T09:00:00.5Z', new Date(Date.UTC(2026, 9, 20, 9, 0, 0, 500))],
        ['2026-10-20T09:00:00.123456Z', new Date(Date.UTC(2026, 9, 20, 9, 0, 0, 123))],
        ['2026-10-20T09:00:00.250+02:00', new Date(Date.UTC(2026, 9, 20, 7, 0, 0, 250))],
        ['2026-10-20T09:00:00.250', new Date(2026, 9, 20, 9, 0, 0, 250)],
        [' 2026-10-20 ', new Date(2026, 9, 20)],
    ])('parses %s', (input, expected) => {
        expect(parseLocalDate(input)?.getTime()).toBe(expected.getTime())
    })

    it.each([
        '',
        'next week',
        '2026',
        '2026-10',
        '20261020',
        '2026-02-30',
        '2026-02-31T10:00',
        '2026-02-30T10:00Z',
        '2026-04-31',
        '2026-13-01',
        '2026-00-10',
        '2026-10-00',
        '2026-10-32',
        '2026-10-20T24:00',
        '2026-10-20T09:60',
        '2026-10-20T09:30:60',
        '2026-10-20T09:60Z',
        '2026-10-20T09:30:60Z',
        '2026-10-20T09:30+02:60',
        '2026-10-20Z',
        '2026-10-20T09:30.5',
        '2026-10-20T09:00:00.',
        '2026-10-20T09:00:00.1234567890Z',
        '0099-01-01',
        '0001-01-01',
        '0000-01-01',
        '0099-01-01T00:00Z',
        '2026-10-20T09:30+14:01',
        '2026-10-20T09:30-12:01',
    ])('rejects %j', (input) => {
        expect(parseLocalDate(input)).toBeNull()
    })

    it('accepts 29 February only in a leap year', () => {
        expect(parseLocalDate('2028-02-29')).not.toBeNull()
        expect(parseLocalDate('2026-02-29')).toBeNull()
    })
})

describe('parseLocalDate round trip', () => {
    it('accepts what Date.toISOString() produces, millisecond for millisecond', () => {
        for (const ms of [0, 1, 999, 1_700_000_000_123, Date.now() + 86_400_000]) {
            const iso = new Date(ms).toISOString()
            expect(parseLocalDate(iso)?.getTime()).toBe(ms)
        }
    })
})

describe('parseLocalDate around daylight saving', () => {
    const originalTz = process.env.TZ

    beforeAll(() => {
        process.env.TZ = 'America/New_York'
    })

    afterAll(() => {
        if (originalTz === undefined) {
            delete process.env.TZ
        } else {
            process.env.TZ = originalTz
        }
    })

    it('rejects a local time that does not exist in the spring-forward gap', () => {
        expect(parseLocalDate('2026-03-08T02:30')).toBeNull()
        expect(parseLocalDate('2026-03-08T02:00:00')).toBeNull()
    })

    it('accepts the times on either side of the gap', () => {
        expect(parseLocalDate('2026-03-08T01:59')).not.toBeNull()
        expect(parseLocalDate('2026-03-08T03:00')).not.toBeNull()
    })

    it('accepts a time that happens twice when the clocks go back', () => {
        expect(parseLocalDate('2026-11-01T01:30')).not.toBeNull()
    })

    it('does not apply the gap rule to an explicit offset', () => {
        expect(parseLocalDate('2026-03-08T02:30Z')).not.toBeNull()
    })
})

describe('parseLocalDate never refuses a real calendar day, in any time zone', () => {
    const originalTz = process.env.TZ
    // Zones whose clocks skip at midnight (so midnight does not exist that day), plus half-hour gaps.
    const zones = [
        'UTC',
        'America/New_York',
        'America/Santiago',
        'America/Havana',
        'Asia/Beirut',
        'Africa/Cairo',
        'Australia/Lord_Howe',
        'Asia/Kolkata',
    ]

    afterAll(() => {
        if (originalTz === undefined) {
            delete process.env.TZ
        } else {
            process.env.TZ = originalTz
        }
    })

    it.each(zones)('accepts every day of 2026 as a date-only value in %s', (zone) => {
        process.env.TZ = zone
        const refused: string[] = []
        for (let day = 0; day < 365; day++) {
            const date = new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10)
            if (parseLocalDate(date) === null) {
                refused.push(date)
            }
        }
        expect(refused).toEqual([])
    })

    it('resolves a date-only value whose midnight is skipped to the first instant of that day', () => {
        process.env.TZ = 'America/Santiago'
        const result = parseLocalDate('2026-09-06')
        expect(result?.toISOString()).toBe('2026-09-06T04:00:00.000Z')
    })

    it('still rejects a typed time inside the gap on that day', () => {
        process.env.TZ = 'America/Santiago'
        expect(parseLocalDate('2026-09-06T00:30')).toBeNull()
        expect(parseLocalDate('2026-09-06T01:00')).not.toBeNull()
    })

    it('resolves a repeated autumn hour to its first occurrence', () => {
        process.env.TZ = 'America/New_York'
        expect(parseLocalDate('2026-11-01T01:30')?.toISOString()).toBe('2026-11-01T05:30:00.000Z')
    })
})

describe('formatDateInTimezone', () => {
    // 02:00 UTC on 9 January is still 8 PM on the 8th in Chicago.
    const instant = new Date('2026-01-09T02:00:00Z')

    it('gives the day the instant falls on in the given time zone', () => {
        expect(formatDateInTimezone(instant, 'America/Chicago')).toBe('2026-01-08')
        expect(formatDateInTimezone(instant, 'Asia/Tokyo')).toBe('2026-01-09')
    })

    it("uses the machine's time zone when none is given", () => {
        // The test run pins the machine's time zone to UTC.
        expect(formatDateInTimezone(instant)).toBe('2026-01-09')
    })

    it('reads a Todoist fixed-offset time zone such as GMT -6:00', () => {
        expect(formatDateInTimezone(instant, 'GMT -6:00')).toBe('2026-01-08')
        // 19:00 UTC on 8 January is already 00:30 on the 9th at +5:30.
        expect(formatDateInTimezone(new Date('2026-01-08T19:00:00Z'), 'GMT +5:30')).toBe(
            '2026-01-09',
        )
    })

    it("uses the machine's time zone for a name it does not know", () => {
        // The test run pins the machine's time zone to UTC.
        expect(formatDateInTimezone(instant, 'Mars/Olympus_Mons')).toBe('2026-01-09')
    })

    it('builds one formatter per time zone however many dates it formats', () => {
        // A zone no other test uses, so its formatter is built here.
        const construct = vi.spyOn(Intl, 'DateTimeFormat')
        for (const day of [9, 10, 11]) {
            formatDateInTimezone(new Date(Date.UTC(2026, 0, day, 12)), 'Pacific/Chatham')
        }
        expect(construct).toHaveBeenCalledTimes(1)
        construct.mockRestore()
    })
})

describe('formatDateTime', () => {
    // 02:00 UTC on 9 January is still 8 PM on the 8th six hours west of UTC.
    const instant = new Date('2026-01-09T02:00:00Z')

    it('shows the date and time in the given time zone', () => {
        expect(formatDateTime(instant, 'America/Chicago')).toBe('Jan 8, 2026, 8:00 PM')
        expect(formatDateTime(instant, 'GMT -6:00')).toBe('Jan 8, 2026, 8:00 PM')
    })

    it("uses the machine's time zone when none is given, or for a name it does not know", () => {
        // The test run pins the machine's time zone to UTC.
        expect(formatDateTime(instant)).toBe('Jan 9, 2026, 2:00 AM')
        expect(formatDateTime(instant, 'Mars/Olympus_Mons')).toBe('Jan 9, 2026, 2:00 AM')
    })
})
