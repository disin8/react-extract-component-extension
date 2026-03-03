import { defineExtension } from 'reactive-vscode'
import { commands, languages } from 'vscode'
import { ExtractComponentActionProvider } from './code-action-provider'
import { extractCommand } from './extract-command'

const JSX_LANGUAGES = ['javascriptreact', 'typescriptreact']

const { activate, deactivate } = defineExtension(() => {
  commands.registerCommand('reactExtractComponent.extract', extractCommand)

  // Register as a code action provider so it appears in the lightbulb / Refactor menu
  for (const lang of JSX_LANGUAGES) {
    languages.registerCodeActionsProvider(
      { language: lang },
      new ExtractComponentActionProvider(),
      { providedCodeActionKinds: ExtractComponentActionProvider.providedCodeActionKinds },
    )
  }
})

export { activate, deactivate }
