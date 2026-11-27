import { Command } from 'commander'
import { CliError } from '../../lib/errors.js'
import { failWithUsage } from '../../lib/missing-argument.js'
import { exportProject, type ExportOptions } from '../project/export.js'
import { importIntoProject } from '../project/import.js'
import { createFromTemplate, type CreateFromTemplateOptions } from './create.js'
import { exportTemplateUrl, type ExportUrlOptions } from './export-url.js'
import { warnDeprecated } from './helpers.js'

export function registerTemplateCommand(program: Command): void {
    const template = program
        .command('template')
        .description('Manage templates')
        .addHelpText(
            'after',
            `
To use a template, see:
  td project create --from-template <id>             Create a project from a template
  td project import <project> --from-template <id>   Add a template to an existing project`,
        )

    // Deprecated: moved to `td project export`. Hidden, kept for one release.
    const exportFileCmd = template
        .command('export-file [project]', { hidden: true })
        .description('Deprecated: use `td project export`')
        .option('--project <ref>', 'Project reference (name or id:xxx)')
        .option('--relative-dates', 'Use relative dates in the export')
        .option('--output <path>', 'Write to file instead of stdout')
        .option('--json', 'Output as JSON')
        .action((projectArg: string | undefined, options: ExportOptions) => {
            warnDeprecated('td template export-file', 'td project export')
            if (projectArg && options.project) {
                throw new CliError(
                    'CONFLICTING_OPTIONS',
                    'Cannot specify project both as argument and --project flag',
                )
            }
            const ref = projectArg || options.project
            if (!ref) {
                failWithUsage(exportFileCmd)
                return
            }
            return exportProject(ref, options)
        })

    const exportUrlCmd = template
        .command('export-url [project]')
        .description('Export a project as a template URL')
        .option('--project <ref>', 'Project reference (name or id:xxx)')
        .option('--relative-dates', 'Use relative dates in the export')
        .option('--json', 'Output as JSON')
        .action((projectArg: string | undefined, options: ExportUrlOptions) => {
            if (projectArg && options.project) {
                throw new CliError(
                    'CONFLICTING_OPTIONS',
                    'Cannot specify project both as argument and --project flag',
                )
            }
            const ref = projectArg || options.project
            if (!ref) {
                failWithUsage(exportUrlCmd)
                return
            }
            return exportTemplateUrl(ref, options)
        })

    template
        .command('create')
        .description('Deprecated: use `td project create --from-csv`')
        .requiredOption('--name <name>', 'Name for the new project')
        .requiredOption('--file <path>', 'Path to the template file')
        .option('--file-name <name>', 'Override the file name sent to the API')
        .option('--workspace <ref>', 'Workspace to create the project in')
        .option('--json', 'Output as JSON')
        .option('--dry-run', 'Preview what would happen without executing')
        .action((options: CreateFromTemplateOptions) => {
            warnDeprecated('td template create --file', 'td project create --from-csv')
            return createFromTemplate(options)
        })

    // Deprecated: moved to `td project import --from-csv`. Hidden, kept for one release.
    const importFileCmd = template
        .command('import-file [project]', { hidden: true })
        .description('Deprecated: use `td project import --from-csv`')
        .option('--project <ref>', 'Project reference (name or id:xxx)')
        .requiredOption('--file <path>', 'Path to the CSV file')
        .option('--file-name <name>', 'Override the file name sent to the API')
        .option('--json', 'Output as JSON')
        .option('--dry-run', 'Preview what would happen without executing')
        .action((projectArg: string | undefined, options: DeprecatedImportFileOptions) => {
            warnDeprecated('td template import-file', 'td project import --from-csv')
            const ref = projectRefFrom(projectArg, options.project)
            if (!ref) {
                failWithUsage(importFileCmd)
                return
            }
            const { file, ...rest } = options
            return importIntoProject(ref, { ...rest, fromCsv: file })
        })

    // Deprecated: moved to `td project import --from-template`. Hidden, kept for one release.
    const importIdCmd = template
        .command('import-id [project]', { hidden: true })
        .description('Deprecated: use `td project import --from-template`')
        .option('--project <ref>', 'Project reference (name or id:xxx)')
        .requiredOption('--template-id <id>', 'The template ID to import')
        .option('--locale <locale>', 'Locale for the import (default: en)')
        .option('--json', 'Output as JSON')
        .option('--dry-run', 'Preview what would happen without executing')
        .action((projectArg: string | undefined, options: DeprecatedImportIdOptions) => {
            warnDeprecated('td template import-id', 'td project import --from-template')
            const ref = projectRefFrom(projectArg, options.project)
            if (!ref) {
                failWithUsage(importIdCmd)
                return
            }
            const { templateId, ...rest } = options
            return importIntoProject(ref, { ...rest, fromTemplate: templateId })
        })
}

interface DeprecatedImportFileOptions {
    project?: string
    file: string
    fileName?: string
    json?: boolean
    dryRun?: boolean
}

interface DeprecatedImportIdOptions {
    project?: string
    templateId: string
    locale?: string
    json?: boolean
    dryRun?: boolean
}

function projectRefFrom(projectArg: string | undefined, projectOption: string | undefined) {
    if (projectArg && projectOption) {
        throw new CliError(
            'CONFLICTING_OPTIONS',
            'Cannot specify project both as argument and --project flag',
        )
    }
    return projectArg || projectOption
}
