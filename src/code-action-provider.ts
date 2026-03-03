import * as vscode from 'vscode'
import { isValidJsx } from './analyzer'

/**
 * Provides "Extract JSX to Component" as a refactor action in the
 * lightbulb / quick-fix menu when a valid JSX fragment is selected.
 */
export class ExtractComponentActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.RefactorExtract,
  ]

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Selection | vscode.Range,
  ): vscode.CodeAction[] | undefined {
    if (range.isEmpty)
      return undefined

    const selectedText = document.getText(range)
    if (!selectedText.trim())
      return undefined

    // Only offer the action when selection looks like JSX
    if (!isValidJsx(selectedText.trim()))
      return undefined

    const action = new vscode.CodeAction(
      'Extract JSX to Component',
      vscode.CodeActionKind.RefactorExtract,
    )
    action.command = {
      command: 'reactExtractComponent.extract',
      title: 'Extract JSX to Component',
      tooltip: 'Extract the selected JSX fragment into a new React functional component',
    }
    // Mark as preferred so it shows first in the refactor list
    action.isPreferred = false

    return [action]
  }
}
