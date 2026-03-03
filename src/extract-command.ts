import * as path from 'node:path'
import * as vscode from 'vscode'
import { analyzeSelection, extractKeyExpressionFromJsx, findImportsExclusiveToSelection, isMultiRootJsx, removeImportsFromSource, stripKeyPropFromJsx } from './analyzer'
import { computeRelativeImport, getFileName } from './file-utils'
import {
  generateComponentCode,
  generateComponentUsage,
  generateNewFileContent,
} from './generator'

/**
 * Read extension configuration values
 */
function getConfig() {
  const cfg = vscode.workspace.getConfiguration('reactExtractComponent')
  return {
    fileNameConvention: cfg.get<'PascalCase' | 'camelCase' | 'kebab-case'>('fileNameConvention', 'kebab-case'),
    createComponentFolder: cfg.get<boolean>('createComponentFolder', false),
    propsInterfaceNaming: cfg.get<'IPrefix' | 'Suffix'>('propsInterfaceNaming', 'IPrefix'),
  }
}

/**
 * Determine if the current file is TypeScript
 */
function isTypeScriptFile(fileName: string): boolean {
  return fileName.endsWith('.tsx') || fileName.endsWith('.ts')
}

/**
 * Get the file extension to use for the new component file
 */
function getComponentExtension(sourceFileName: string): string {
  if (sourceFileName.endsWith('.tsx'))
    return 'tsx'
  if (sourceFileName.endsWith('.jsx'))
    return 'jsx'
  if (sourceFileName.endsWith('.ts'))
    return 'tsx'
  return 'jsx'
}

/**
 * Find the first import declaration end position in the source text
 * to insert new import after existing imports
 */
function findImportInsertPosition(source: string): number {
  const lines = source.split('\n')
  let lastImportLine = -1

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith('import ') || trimmed.startsWith('import{')) {
      lastImportLine = i
    }
  }

  if (lastImportLine === -1)
    return 0

  let pos = 0
  for (let i = 0; i <= lastImportLine; i++) {
    pos += lines[i].length + 1
  }
  return pos
}

/**
 * Main command handler: extract to component
 */
export async function extractCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    vscode.window.showErrorMessage('No active editor found')
    return
  }

  const { document, selection } = editor
  if (selection.isEmpty) {
    vscode.window.showErrorMessage('Please select a JSX fragment to extract')
    return
  }

  const selectedText = document.getText(selection)
  const fullSource = document.getText()
  const selectionStartOffset = document.offsetAt(selection.start)
  const selectionEndOffset = document.offsetAt(selection.end)

  const analysis = analyzeSelection(fullSource, selectionStartOffset, selectionEndOffset)

  if (!analysis.isValidJsx) {
    vscode.window.showErrorMessage(analysis.error || 'Selected text is not valid JSX')
    return
  }

  const componentName = await vscode.window.showInputBox({
    prompt: 'Enter the name for the new component',
    placeHolder: 'NewComponent',
    validateInput: (value) => {
      if (!value)
        return 'Component name is required'
      if (!/^[A-Z][a-zA-Z0-9]*$/.test(value))
        return 'Component name must be PascalCase (start with uppercase letter)'
      return undefined
    },
  })

  if (!componentName)
    return

  const placement = await vscode.window.showQuickPick(
    [
      { label: 'Same file', description: 'Add component at the end of the current file', value: 'same' as const },
      { label: 'New file', description: 'Create a new file for the component', value: 'new' as const },
    ],
    {
      placeHolder: 'Where should the new component be placed?',
    },
  )

  if (!placement)
    return

  const config = getConfig()
  const isTs = isTypeScriptFile(document.fileName)

  const keyExpression = extractKeyExpressionFromJsx(selectedText)
  const jsxFragment = keyExpression ? stripKeyPropFromJsx(selectedText) : selectedText

  const generateOptions = {
    componentName,
    jsxFragment,
    wrapInFragment: isMultiRootJsx(jsxFragment),
    props: analysis.props,
    requiredImports: analysis.requiredImports,
    propsInterfaceNaming: config.propsInterfaceNaming,
    isTypeScript: isTs,
  }

  if (placement.value === 'same') {
    await extractToSameFile(editor, selection, componentName, generateOptions, keyExpression ?? undefined)
  }
  else {
    await extractToNewFile(editor, selection, componentName, generateOptions, config, keyExpression ?? undefined)
  }
}

/**
 * Extract component to the same file (append at bottom)
 */
async function extractToSameFile(
  editor: vscode.TextEditor,
  selection: vscode.Selection,
  componentName: string,
  options: Parameters<typeof generateComponentCode>[0],
  keyExpression?: string,
): Promise<void> {
  const { document } = editor
  const componentCode = generateComponentCode(options)
  const usageCode = generateComponentUsage(componentName, options.props, keyExpression)

  await editor.edit((editBuilder) => {
    editBuilder.replace(selection, usageCode)

    const lastLine = document.lineAt(document.lineCount - 1)
    const endPos = lastLine.range.end
    editBuilder.insert(endPos, `\n\n${componentCode}\n`)
  })

  vscode.window.showInformationMessage(
    `Extracted <${componentName} /> with ${options.props.length} prop(s)`,
  )
}

/**
 * Extract component to a new file
 */
async function extractToNewFile(
  editor: vscode.TextEditor,
  selection: vscode.Selection,
  componentName: string,
  options: Parameters<typeof generateNewFileContent>[0],
  config: ReturnType<typeof getConfig>,
  keyExpression?: string,
): Promise<void> {
  const { document } = editor
  const sourceDir = path.dirname(document.fileName)
  const ext = getComponentExtension(document.fileName)

  const originalSource = document.getText()
  const selectionStartOffset = document.offsetAt(selection.start)
  const selectionEndOffset = document.offsetAt(selection.end)

  const exclusiveImports = findImportsExclusiveToSelection(
    originalSource,
    selectionStartOffset,
    selectionEndOffset,
  )

  let targetDir: string
  let targetFileName: string
  let importPath: string

  if (config.createComponentFolder) {
    const folderName = getFileName(componentName, config.fileNameConvention, '').replace(/\.$/, '')
    targetDir = path.join(sourceDir, folderName)
    targetFileName = `index.${ext}`
    importPath = computeRelativeImport(
      document.fileName,
      path.join(targetDir, targetFileName),
    )
    importPath = importPath.replace(/\/index$/, '')
  }
  else {
    targetDir = sourceDir
    targetFileName = getFileName(componentName, config.fileNameConvention, ext)
    importPath = computeRelativeImport(
      document.fileName,
      path.join(targetDir, targetFileName),
    )
  }

  const targetPath = path.join(targetDir, targetFileName)

  // Check if file already exists
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(targetPath))
    const overwrite = await vscode.window.showWarningMessage(
      `File "${targetFileName}" already exists. Overwrite?`,
      'Yes',
      'No',
    )
    if (overwrite !== 'Yes')
      return
  }
  catch {
    // File doesn't exist, which is expected
  }

  const fileContent = generateNewFileContent(options)

  await vscode.workspace.fs.createDirectory(vscode.Uri.file(targetDir))

  const encoder = new TextEncoder()
  await vscode.workspace.fs.writeFile(
    vscode.Uri.file(targetPath),
    encoder.encode(fileContent),
  )

  if (config.createComponentFolder) {
    const barrelPath = path.join(targetDir, `index.${ext === 'tsx' ? 'ts' : 'js'}`)
    if (targetFileName !== `index.${ext}`) {
      const barrelContent = `export { default } from './${targetFileName.replace(/\.[^.]+$/, '')}'\nexport * from './${targetFileName.replace(/\.[^.]+$/, '')}'\n`
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(barrelPath),
        encoder.encode(barrelContent),
      )
    }
  }

  const usageCode = generateComponentUsage(componentName, options.props, keyExpression)

  const importLine = `import ${componentName} from '${importPath}'`

  const importInsertOffset = findImportInsertPosition(originalSource)
  const importInsertPos = document.positionAt(importInsertOffset)

  await editor.edit((editBuilder) => {
    editBuilder.replace(selection, usageCode)

    editBuilder.insert(importInsertPos, `${importLine}\n`)
  })

  if (exclusiveImports.length > 0) {
    const updatedSource = document.getText()
    const cleaned = removeImportsFromSource(updatedSource, exclusiveImports)
    if (cleaned !== updatedSource) {
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(updatedSource.length),
      )
      await editor.edit(eb => eb.replace(fullRange, cleaned))
    }
  }

  // Open the new file, format it, and save
  const newFileUri = vscode.Uri.file(targetPath)
  const newDoc = await vscode.workspace.openTextDocument(newFileUri)
  await vscode.window.showTextDocument(newDoc, { preview: false })
  await vscode.commands.executeCommand('editor.action.formatDocument')
  await newDoc.save()

  vscode.window.showInformationMessage(
    `Extracted <${componentName} /> to ${targetFileName}`,
  )
}
