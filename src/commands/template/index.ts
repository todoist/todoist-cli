import { type ColorKey, colors } from '@todoist/sdk'
import { Command, Option } from 'commander'
import { withCaseInsensitiveChoices } from '../../lib/completion.js'
import { CURSOR_DESCRIPTION } from '../../lib/constants.js'
import { CliError } from '../../lib/errors.js'
import { failWithUsage } from '../../lib/missing-argument.js'
import { exportProject, type ExportOptions } from '../project/export.js'
import { importIntoProject } from '../project/import.js'
import { createTemplateFromCsv } from './create-from-csv.js'
import { createFromTemplate } from './create.js'
import { exportTemplateUrl, type ExportUrlOptions } from './export-url.js'
import { warnDeprecated } from './helpers.js'
import { listTemplates, TEMPLATE_SOURCE_CHOICES, type ListTemplatesOptions } from './list.js'
import { updateTemplate, type UpdateTemplateOptions } from './update.js'
import { viewTemplate, type ViewTemplateOptions } from './view.js'

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

    template
        .command('list')
        .description("List templates: yours, your workspaces' and the gallery's")
        .option('--search <query>', 'Search template names and descriptions')
        .addOption(
            withCaseInsensitiveChoices(
                new Option('--source <source>', 'Where to list templates from (default: all)'),
                [...TEMPLATE_SOURCE_CHOICES],
            ),
        )
        .option('--category <slug>', 'Gallery category')
        .option('--locale <locale>', 'Language of gallery templates (default: en)')
        .option('--limit <n>', 'Limit number of results (default: 50)')
        .option('--cursor <cursor>', CURSOR_DESCRIPTION)
        .option('--all', 'Fetch all results (no limit)')
        .option('--json', 'Output as JSON')
        .option('--ndjson', 'Output as newline-delimited JSON')
        .option('--ids-only', 'Output only IDs, one per line')
        .option('--full', 'Include all fields in JSON output')
        .action((options: ListTemplatesOptions) => listTemplates(options))

    template
        .command('view <id>')
        .description('View a template: a gallery slug or a UT_ template ID')
        .option('--content', 'Include its sections and tasks')
        .option('--locale <locale>', 'Language of a gallery template (default: en)')
        .option('--json', 'Output as JSON')
        .option('--full', 'Include all fields in JSON output')
        .action((id: string, options: ViewTemplateOptions) => viewTemplate(id, options))

    template
        .command('update <id>')
        .description('Update a saved template (UT_ template ID)')
        .option('--name <name>', 'New name')
        .option('--description <text>', 'New description')
        .addOption(
            withCaseInsensitiveChoices(
                new Option('--color <color>', 'New color'),
                colors.map((c) => c.key),
            ),
        )
        .option('--workspace <ref>', 'Move a personal template into this workspace')
        .option('--share', 'Share a workspace template with its members')
        .option('--no-share', 'Stop sharing a workspace template with its members')
        .option('--from-project <ref>', "Replace the content with a project's current content")
        .option(
            '--content-file <path>',
            'Replace the content with JSON from `td template view <id> --content --json`',
        )
        .option('--json', 'Output the updated template as JSON')
        .option('--dry-run', 'Preview what would happen without executing')
        .addHelpText(
            'after',
            `
Replacing the content removes anything left out of it.

Examples:
  td template update UT_abc123 --name "Onboarding v2" --color lime_green
  td template update UT_abc123 --workspace "Acme" --share
  td template view UT_abc123 --content --json > onboarding.json   # edit, then:
  td template update UT_abc123 --content-file onboarding.json`,
        )
        .action((id: string, options: UpdateTemplateOptions) => updateTemplate(id, options))

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
        .description('Create a template from a CSV file')
        .requiredOption('--name <name>', 'Template name')
        .option('--from-csv <path>', 'CSV file to create the template from')
        .option('--description <text>', 'Description shown with the template (required)')
        .addOption(
            withCaseInsensitiveChoices(
                new Option('--color <color>', 'Template color (default: charcoal)'),
                colors.map((c) => c.key),
            ),
        )
        .option('--file-name <name>', 'Override the file name sent to the API')
        .option(
            '--file <path>',
            'Deprecated: creates a project. Use `td project create --from-csv`',
        )
        .option('--workspace <ref>', 'Deprecated, with --file: workspace for the new project')
        .option('--json', 'Output as JSON')
        .option('--dry-run', 'Preview what would happen without executing')
        .addHelpText(
            'after',
            `
Each run saves a new template. Templates can't be deleted from the CLI yet.
To save a project as a template, use: td project save-as-template <project>

Examples:
  td template create --name "Onboarding" --from-csv onboarding.csv --description "Steps for a new hire"`,
        )
        .action((options: TemplateCreateOptions) => {
            if (options.file !== undefined) {
                // Before --from-csv, `td template create --file` created a project. It keeps
                // doing that for one release; the different option name keeps old scripts
                // from silently creating templates instead.
                if (options.fromCsv !== undefined) {
                    throw new CliError(
                        'CONFLICTING_OPTIONS',
                        '--file creates a project and --from-csv creates a template: use one',
                    )
                }
                rejectTemplateOnlyOptions(options, '--file')
                warnDeprecated('td template create --file', 'td project create --from-csv')
                return createFromTemplate({ ...options, file: options.file })
            }
            if (options.fromCsv === undefined) {
                throw new CliError('INVALID_OPTIONS', 'Specify the CSV file: --from-csv <path>', [
                    'To save a project as a template: td project save-as-template <project>',
                ])
            }
            if (options.workspace !== undefined) {
                throw new CliError(
                    'INVALID_OPTIONS',
                    '--workspace only applies to the deprecated --file',
                    [
                        'A template from CSV is saved to your personal templates. Move it afterwards with: td template update <id> --workspace <ref>',
                    ],
                )
            }
            if (!options.description) {
                throw new CliError('INVALID_OPTIONS', 'A description is required (--description)')
            }
            return createTemplateFromCsv({
                ...options,
                fromCsv: options.fromCsv,
                description: options.description,
            })
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

interface TemplateCreateOptions {
    name: string
    fromCsv?: string
    description?: string
    color?: ColorKey
    fileName?: string
    file?: string
    workspace?: string
    json?: boolean
    dryRun?: boolean
}

function rejectTemplateOnlyOptions(options: TemplateCreateOptions, flag: string): void {
    const given = (
        [
            ['description', '--description'],
            ['color', '--color'],
        ] as const
    )
        .filter(([key]) => options[key] !== undefined)
        .map(([, name]) => name)
    if (given.length > 0) {
        throw new CliError(
            'INVALID_OPTIONS',
            `${given.join(', ')} can't be used with ${flag}, which creates a project`,
            ['To create a template from the CSV, use --from-csv instead of --file.'],
        )
    }
}
