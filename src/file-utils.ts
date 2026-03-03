/**
 * File naming utilities for component generation
 */

/**
 * Convert a PascalCase component name to kebab-case
 */
export function toKebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
}

/**
 * Convert a PascalCase component name to camelCase
 */
export function toCamelCase(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1)
}

/**
 * Get the file name based on the naming convention
 */
export function getFileName(
  componentName: string,
  convention: 'PascalCase' | 'camelCase' | 'kebab-case',
  extension: string,
): string {
  switch (convention) {
    case 'PascalCase':
      return `${componentName}.${extension}`
    case 'camelCase':
      return `${toCamelCase(componentName)}.${extension}`
    case 'kebab-case':
      return `${toKebabCase(componentName)}.${extension}`
    default:
      return `${componentName}.${extension}`
  }
}

/**
 * Compute a relative import path from one file to another
 * Both paths should be absolute or both relative to the same root
 */
export function computeRelativeImport(fromFile: string, toFile: string): string {
  const fromParts = fromFile.split('/').slice(0, -1) // directory of source
  const toParts = toFile.split('/')

  // Find common prefix length
  let commonLength = 0
  while (
    commonLength < fromParts.length
    && commonLength < toParts.length
    && fromParts[commonLength] === toParts[commonLength]
  ) {
    commonLength++
  }

  const upCount = fromParts.length - commonLength
  const remainingParts = toParts.slice(commonLength)

  let result: string
  if (upCount === 0) {
    result = `./${remainingParts.join('/')}`
  }
  else {
    result = `${'../'.repeat(upCount)}${remainingParts.join('/')}`
  }

  // Remove file extension for import
  return result.replace(/\.(tsx?|jsx?)$/, '')
}
