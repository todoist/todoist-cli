import type { TemplateContent } from '@todoist/sdk'
import chalk from 'chalk'
import { getApi } from '../../lib/api/core.js'
import { formatJson } from '../../lib/output.js'
import { describeTemplateSource } from './helpers.js'

export interface ViewTemplateOptions {
    content?: boolean
    locale?: string
    json?: boolean
    full?: boolean
}

export async function viewTemplate(id: string, options: ViewTemplateOptions): Promise<void> {
    const api = await getApi()
    const [template, content] = await Promise.all([
        api.getTemplate(id, { locale: options.locale }),
        options.content ? api.getTemplateContent(id, { locale: options.locale }) : undefined,
    ])

    if (options.json) {
        const base = JSON.parse(formatJson(template, 'template', options.full)) as object
        console.log(formatJson(content ? { ...base, content: content.content } : base))
        return
    }

    console.log(chalk.bold(template.name))
    console.log(chalk.dim(`ID: ${template.id}`))
    console.log(chalk.dim(`Source: ${describeTemplateSource(template)}`))
    if (template.shortDescription) {
        console.log('')
        console.log(template.shortDescription)
    }
    if (content) {
        console.log('')
        printContent(content.content)
    }
}

function printContent(content: TemplateContent): void {
    const tasksIn = (sectionId: string | null) =>
        content.tasks.filter((task) => (task.sectionId ?? null) === sectionId && !task.parentId)
    const subtasksOf = (taskId: string) => content.tasks.filter((task) => task.parentId === taskId)

    const printTask = (task: TemplateContent['tasks'][number], depth: number) => {
        console.log(`${'  '.repeat(depth)}- ${task.content}`)
        for (const child of subtasksOf(task.id)) printTask(child, depth + 1)
    }

    const unsectioned = tasksIn(null)
    for (const task of unsectioned) printTask(task, 0)
    content.sections.forEach((section, index) => {
        // A blank line between groups, but not before the first one.
        const separator = index > 0 || unsectioned.length > 0 ? '\n' : ''
        console.log(chalk.bold(`${separator}${section.name}`))
        for (const task of tasksIn(section.id)) printTask(task, 0)
    })
    if (content.tasks.length === 0) {
        console.log(chalk.dim('(no tasks)'))
    }
}
