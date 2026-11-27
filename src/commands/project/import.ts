import type { ImportTemplateResponse } from '@todoist/sdk'
import chalk from 'chalk'
import { getApi } from '../../lib/api/core.js'
import { CliError } from '../../lib/errors.js'
import { openLocalFileAsBlob } from '../../lib/local-file.js'
import { printDryRun } from '../../lib/output.js'
import { resolveProjectRef } from '../../lib/refs.js'

export interface ImportOptions {
    project?: string
    fromCsv?: string
    fromTemplate?: string
    fileName?: string
    locale?: string
    json?: boolean
    dryRun?: boolean
}

/**
 * Checks that exactly one source is given, and that each source-specific option
 * comes with its source, before anything is read or sent.
 */
export function validateImportSource(options: ImportOptions): void {
    if (options.fromCsv && options.fromTemplate) {
        throw new CliError(
            'CONFLICTING_OPTIONS',
            'Use either --from-csv or --from-template, not both',
        )
    }
    if (!options.fromCsv && !options.fromTemplate) {
        throw new CliError(
            'INVALID_OPTIONS',
            'Specify what to import: --from-csv or --from-template',
            [
                'td project import "Roadmap" --from-csv roadmap.csv',
                'td project import "Roadmap" --from-template product-launch',
            ],
        )
    }
    if (options.fileName && !options.fromCsv) {
        throw new CliError('INVALID_OPTIONS', '--file-name only applies with --from-csv')
    }
    if (options.locale && !options.fromTemplate) {
        throw new CliError('INVALID_OPTIONS', '--locale only applies with --from-template')
    }
}

export async function importIntoProject(projectRef: string, options: ImportOptions): Promise<void> {
    validateImportSource(options)

    const csv = options.fromCsv
        ? await openLocalFileAsBlob({ file: options.fromCsv, fileName: options.fileName })
        : undefined

    if (options.dryRun) {
        printDryRun(csv ? 'import CSV into project' : 'import template into project', {
            Project: projectRef,
            CSV: csv?.filePath,
            'File name': options.fileName,
            Template: options.fromTemplate,
            Locale: options.locale,
        })
        return
    }

    const api = await getApi()
    const project = await resolveProjectRef(api, projectRef)

    const result = csv
        ? await api.importCsvIntoProject({
              projectId: project.id,
              file: csv.blob,
              fileName: csv.fileName,
          })
        : await api.importTemplateFromId({
              projectId: project.id,
              templateId: options.fromTemplate as string,
              locale: options.locale,
          })

    if (options.json) {
        console.log(JSON.stringify(result, null, 2))
        return
    }

    console.log(`Imported into: ${project.name}`)
    formatImportResult(result)
}

export function formatImportResult(result: ImportTemplateResponse): void {
    const counts = [
        result.tasks.length > 0 ? `${result.tasks.length} tasks` : null,
        result.sections.length > 0 ? `${result.sections.length} sections` : null,
        result.projects.length > 0 ? `${result.projects.length} projects` : null,
        result.comments.length > 0 ? `${result.comments.length} comments` : null,
    ].filter(Boolean)

    if (counts.length > 0) {
        console.log(`Imported: ${counts.join(', ')}`)
    } else {
        console.log('Nothing imported: no tasks, sections or comments')
    }
    console.log(chalk.dim(`Type: ${result.templateType}`))
}
