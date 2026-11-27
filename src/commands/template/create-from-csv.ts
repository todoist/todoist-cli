import type { ColorKey } from '@todoist/sdk'
import { getApi } from '../../lib/api/core.js'
import { isQuiet } from '../../lib/global-args.js'
import { openLocalFileAsBlob } from '../../lib/local-file.js'
import { printDryRun } from '../../lib/output.js'
import { printSavedTemplate } from './helpers.js'

export interface CreateTemplateFromCsvOptions {
    name: string
    fromCsv: string
    description: string
    color?: ColorKey
    fileName?: string
    json?: boolean
    dryRun?: boolean
}

export async function createTemplateFromCsv(options: CreateTemplateFromCsvOptions): Promise<void> {
    const csv = await openLocalFileAsBlob({ file: options.fromCsv, fileName: options.fileName })
    const color = options.color ?? 'charcoal'

    if (options.dryRun) {
        printDryRun('create template from CSV', {
            Name: options.name,
            Description: options.description,
            Color: color,
            CSV: csv.filePath,
            'File name': options.fileName,
        })
        return
    }

    const api = await getApi()
    const template = await api.addTemplate({
        file: csv.blob,
        fileName: csv.fileName,
        name: options.name,
        description: options.description,
        color,
    })

    if (options.json) {
        console.log(JSON.stringify(template, null, 2))
        return
    }

    if (isQuiet()) {
        console.log(template.id)
        return
    }

    printSavedTemplate(template)
}
