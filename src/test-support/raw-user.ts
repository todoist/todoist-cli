/**
 * The user resource as the API sends it (snake_case), for tests that run the real SDK and stub
 * only the transport: the `user` in a sync response, or the body of `GET /user`. The SDK
 * validates the whole resource, so this carries every field either requires; pass `overrides`
 * for the fields a test is about.
 */
export function rawUser(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: '1',
        email: 'a@example.com',
        full_name: 'A',
        activated_user: true,
        auto_reminder: 0,
        business_account_id: null,
        completed_count: 0,
        completed_today: 0,
        daily_goal: 5,
        date_format: 0,
        days_off: [],
        feature_identifier: 'x',
        features: {
            karma_disabled: false,
            restriction: 3,
            karma_vacation: false,
            dateist_lang: null,
            beta: 0,
            has_push_reminders: true,
            dateist_inline_disabled: false,
        },
        has_magic_number: false,
        has_password: true,
        image_id: null,
        inbox_project_id: '2',
        is_celebrations_enabled: true,
        is_premium: false,
        joinable_workspace: null,
        joined_at: '2020-01-01T00:00:00Z',
        getting_started_guide_projects: null,
        karma: 0,
        karma_trend: 'none',
        lang: 'en',
        next_week: 1,
        premium_status: 'not_premium',
        premium_until: null,
        share_limit: 5,
        sort_order: 0,
        start_day: 1,
        start_page: 'today',
        theme_id: '0',
        time_format: 0,
        tz_info: { timezone: 'UTC', hours: 0, minutes: 0, is_dst: 0, gmt_string: '+00:00' },
        unique_prefix: 1,
        verification_status: 'verified',
        websocket_url: 'wss://example.com',
        weekend_start_day: 6,
        weekly_goal: 30,
        ...overrides,
    }
}
