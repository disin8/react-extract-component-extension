import type { ImportInfo, PropInfo } from './analyzer'

export interface GenerateComponentOptions {
  /** Name of the new component (PascalCase) */
  componentName: string
  /** The selected JSX fragment */
  jsxFragment: string
  /** When true the JSX has multiple root elements and must be wrapped in <></> */
  wrapInFragment?: boolean
  /** Detected props for the new component */
  props: PropInfo[]
  /** Imports that need to be duplicated in a new file */
  requiredImports: ImportInfo[]
  /** Props interface naming pattern */
  propsInterfaceNaming: 'IPrefix' | 'Suffix'
  /** Whether the source file is TypeScript (.tsx) */
  isTypeScript: boolean
}

/**
 * Generate the interface name for props based on the naming convention
 */
function getPropsInterfaceName(componentName: string, naming: 'IPrefix' | 'Suffix'): string {
  if (naming === 'IPrefix')
    return `I${componentName}Props`
  return `${componentName}Props`
}

/**
 * Generate import statements string from ImportInfo array
 */
export function generateImportsCode(imports: ImportInfo[]): string {
  if (imports.length === 0)
    return ''

  const lines: string[] = []

  for (const imp of imports) {
    const defaultSpec = imp.specifiers.find(s => s.type === 'default')
    const namespaceSpec = imp.specifiers.find(s => s.type === 'namespace')
    const namedSpecs = imp.specifiers.filter(s => s.type === 'named')

    const parts: string[] = []

    if (defaultSpec)
      parts.push(defaultSpec.local)

    if (namespaceSpec)
      parts.push(`* as ${namespaceSpec.local}`)

    if (namedSpecs.length > 0) {
      const namedParts = namedSpecs.map((s) => {
        if (s.imported && s.imported !== s.local)
          return `${s.imported} as ${s.local}`
        return s.local
      })
      parts.push(`{ ${namedParts.join(', ')} }`)
    }

    lines.push(`import ${parts.join(', ')} from '${imp.source}'`)
  }

  return `${lines.join('\n')}\n`
}

/**
 * Generate a TypeScript interface for the component props
 */
function generatePropsInterface(
  interfaceName: string,
  props: PropInfo[],
): string {
  if (props.length === 0)
    return ''

  const fields = props
    .map(p => `  ${p.name}: ${p.type}`)
    .join('\n')

  return `interface ${interfaceName} {\n${fields}\n}\n`
}

/**
 * Generate the full component definition string
 */
export function generateComponentCode(options: GenerateComponentOptions): string {
  const {
    componentName,
    jsxFragment,
    wrapInFragment,
    props,
    propsInterfaceNaming,
    isTypeScript,
  } = options

  const lines: string[] = []

  if (isTypeScript && props.length > 0) {
    const interfaceName = getPropsInterfaceName(componentName, propsInterfaceNaming)
    lines.push(generatePropsInterface(interfaceName, props))

    const destructured = props.map(p => p.name).join(', ')
    lines.push(`const ${componentName} = ({ ${destructured} }: ${interfaceName}) => (`)
  }
  else if (props.length > 0) {
    const destructured = props.map(p => p.name).join(', ')
    lines.push(`const ${componentName} = ({ ${destructured} }) => (`)
  }
  else {
    lines.push(`const ${componentName} = () => (`)
  }

  // When there are multiple root elements, wrap in a React Fragment
  const bodySource = wrapInFragment ? `<>\n${jsxFragment}\n</>` : jsxFragment

  // Indent the JSX body
  const indentedJsx = bodySource
    .split('\n')
    .map(line => `  ${line}`)
    .join('\n')

  lines.push(indentedJsx)
  lines.push(')')

  return lines.join('\n')
}

/**
 * Generate the JSX tag that replaces the selected code
 */
export function generateComponentUsage(
  componentName: string,
  props: PropInfo[],
  keyExpression?: string,
): string {
  const parts: string[] = []

  // key is React-internal — not a component prop, must come first
  if (keyExpression)
    parts.push(`key={${keyExpression}}`)

  for (const p of props)
    parts.push(`${p.name}={${p.name}}`)

  if (parts.length === 0)
    return `<${componentName} />`

  return `<${componentName} ${parts.join(' ')} />`
}

/**
 * Generate a complete new file for an extracted component
 */
export function generateNewFileContent(options: GenerateComponentOptions): string {
  const {
    componentName,
    requiredImports,
  } = options

  const parts: string[] = []

  // Add required imports
  const importsCode = generateImportsCode(requiredImports)
  if (importsCode)
    parts.push(importsCode)

  // Add component code
  parts.push(generateComponentCode(options))

  // Add export
  parts.push('')
  parts.push(`export default ${componentName}`)
  parts.push('')

  return parts.join('\n')
}

/**
 * Generate import statement for the extracted component to add to the original file
 */
export function generateComponentImport(
  componentName: string,
  relativePath: string,
): string {
  // Remove file extension for import
  const importPath = relativePath.replace(/\.(tsx?|jsx?)$/, '')
  return `import ${componentName} from '${importPath}'`
}
