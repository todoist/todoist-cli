import { outputIds, resolveOutputMode } from '@todoist/cli-core'
import type { TemplateSourceFilter } from '@todoist/sdk'
import chalk from 'chalk'
import { getApi } from '../../lib/api/core.js'
import type { PaginatedViewOptions } from '../../lib/options.js'
import {
    formatNextCursorFooter,
    formatNextCursorNotice,
    formatPaginatedJson,
    formatPaginatedNdjson,
} from '../../lib/output.js'
import { paginate } from '../../lib/pagination.js'
import { describeTemplateSource } from './helpers.js'

export const TEMPLATE_SOURCE_CHOICES = ['all', 'personal', 'workspace', 'gallery'] as const
type TemplateSourceChoice = (typeof TEMPLATE_SOURCE_CHOICES)[number]

const SOURCE_FILTERS: Record<TemplateSourceChoice, TemplateSourceFilter> = {
    all: 'all',
    personal: 'user',
    workspace: 'workspace',
    gallery: 'todoist',
}

export type ListTemplatesOptions = PaginatedViewOptions & {
    search?: string
    source?: TemplateSourceChoice
    category?: string
    locale?: string
}

export async function listTemplates(options: ListTemplatesOptions): Promise<void> {
    const outputMode = resolveOutputMode(options)
    const api = await getApi()

    const targetLimit = options.all
        ? Number.MAX_SAFE_INTEGER
        : options.limit
          ? parseInt(options.limit, 10)
          : 50

    const { results: templates, nextCursor } = await paginate(
        (cursor, limit) =>
            api.getTemplates({
                query: options.search,
                templateSource: SOURCE_FILTERS[options.source ?? 'all'],
                categoryId: options.category,
                locale: options.locale,
                cursor,
                limit,
            }),
        { limit: targetLimit, startCursor: options.cursor },
    )

    if (outputMode === 'ids-only') {
        outputIds(templates, (template) => template.id, formatNextCursorNotice(nextCursor))
        return
    }

    if (outputMode === 'json') {
        console.log(
            formatPaginatedJson({ results: templates, nextCursor }, 'template', options.full),
        )
        return
    }

    if (outputMode === 'ndjson') {
        console.log(
            formatPaginatedNdjson({ results: templates, nextCursor }, 'template', options.full),
        )
        return
    }

    if (templates.length === 0) {
        console.log(options.search ? `No templates matching "${options.search}".` : 'No templates.')
        return
    }

    for (const template of templates) {
        console.log(
            `${chalk.dim(template.id)}  ${template.name}  ${chalk.dim(`(${describeTemplateSource(template)})`)}`,
        )
    }
    console.log(formatNextCursorFooter(nextCursor))
}
