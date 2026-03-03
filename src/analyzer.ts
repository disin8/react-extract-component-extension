import type { NodePath } from '@babel/traverse'
import type * as t from '@babel/types'
import { parse } from '@babel/parser'
import _traverse from '@babel/traverse'

// Handle CJS/ESM interop for @babel/traverse
const traverse = (typeof _traverse === 'function' ? _traverse : (_traverse as any).default) as typeof _traverse

/**
 * Set of global identifiers that should never be treated as props
 */
const GLOBAL_IDENTIFIERS = new Set([
  // Browser globals
  'window',
  'document',
  'navigator',
  'location',
  'history',
  'localStorage',
  'sessionStorage',
  'fetch',
  'URL',
  'URLSearchParams',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'Promise',
  'Proxy',
  'Reflect',
  'Symbol',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'Int8Array',
  'Uint8Array',
  'Float32Array',
  'Float64Array',
  'TextEncoder',
  'TextDecoder',
  'AbortController',
  'AbortSignal',
  'Event',
  'CustomEvent',
  'EventTarget',
  'FormData',
  'Headers',
  'Request',
  'Response',
  'Blob',
  'File',
  'FileReader',
  'MutationObserver',
  'IntersectionObserver',
  'ResizeObserver',
  'performance',
  'crypto',

  // JS built-ins
  'console',
  'Math',
  'JSON',
  'Date',
  'RegExp',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'encodeURIComponent',
  'decodeURIComponent',
  'encodeURI',
  'decodeURI',
  'NaN',
  'Infinity',
  'undefined',
  'null',
  'globalThis',

  // React globals (commonly used without import in JSX scope)
  'React',

  // Common type-only identifiers that may leak as value references
  'true',
  'false',
])

/**
 * Represents a detected prop dependency
 */
export interface PropInfo {
  /** Name of the variable used inside the selection */
  name: string
  /** Inferred TypeScript type annotation (string form), or 'any' if unknown */
  type: string
}

/**
 * Represents an import statement from the original file
 */
export interface ImportInfo {
  source: string
  specifiers: Array<{
    type: 'default' | 'named' | 'namespace'
    local: string
    imported?: string
  }>
}

/**
 * Result of analyzing a JSX selection
 */
export interface AnalysisResult {
  /** Variables that need to be passed as props */
  props: PropInfo[]
  /** Imports from the original file that the extracted code depends on */
  requiredImports: ImportInfo[]
  /** Whether the selected code is valid JSX */
  isValidJsx: boolean
  /** Error message if parsing failed */
  error?: string
}

/**
 * Parse full file source code and return the Babel AST
 */
function parseFullFile(source: string) {
  return parse(source, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'],
    errorRecovery: true,
  })
}

/**
 * Validate that a text fragment is valid JSX by wrapping it and parsing
 */
export function isValidJsx(text: string): boolean {
  try {
    parse(`<>${text}</>`, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
    })
    return true
  }
  catch {
    return false
  }
}

/**
 * Returns true when the JSX text has more than one top-level element
 * (siblings that can't be returned from a component without a Fragment wrapper).
 */
export function isMultiRootJsx(text: string): boolean {
  try {
    const ast = parse(`<>${text}</>`, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
    })
    const expr = (ast.program.body[0] as t.ExpressionStatement).expression
    if (expr.type !== 'JSXFragment')
      return false
    const realChildren = expr.children.filter(
      c => c.type !== 'JSXText' || c.value.trim() !== '',
    )
    return realChildren.length > 1
  }
  catch {
    return false
  }
}

/**
 * Extract the raw source text of the `key` attribute's value from a JSX fragment,
 * e.g. `<li key={item.id}>` → `'item.id'`, `<li key="str">` → `'"str"'`.
 * Returns null if no key attribute is present.
 */
export function extractKeyExpressionFromJsx(fragment: string): string | null {
  const wrapped = `<>${fragment}</>`
  try {
    const ast = parse(wrapped, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
    })
    let keyExpr: string | null = null
    traverse(ast, {
      JSXAttribute(path: NodePath<t.JSXAttribute>) {
        const { node } = path
        if (
          node.name.type === 'JSXIdentifier'
          && node.name.name === 'key'
          && node.value != null
        ) {
          if (
            node.value.type === 'JSXExpressionContainer'
            && node.value.expression.type !== 'JSXEmptyExpression'
          ) {
            const expr = node.value.expression
            keyExpr = wrapped.slice(expr.start!, expr.end!)
          }
          else if (node.value.type === 'StringLiteral') {
            // key="literal" → keep as "literal"
            keyExpr = JSON.stringify(node.value.value)
          }
          path.stop()
        }
      },
    })
    return keyExpr
  }
  catch {
    return null
  }
}

/**
 * Remove the `key={...}` / `key="..."` attribute from a JSX fragment string.
 * Used so the extracted component body doesn't carry a key prop.
 */
export function stripKeyPropFromJsx(jsx: string): string {
  const wrapped = `<>${jsx}</>`
  let ast: t.File
  try {
    ast = parse(wrapped, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
    })
  }
  catch {
    return jsx
  }

  const ranges: Array<{ start: number, end: number }> = []
  traverse(ast, {
    JSXAttribute(path: NodePath<t.JSXAttribute>) {
      const { node } = path
      if (
        node.name.type === 'JSXIdentifier'
        && node.name.name === 'key'
        && node.start != null
        && node.end != null
      ) {
        // Also consume any leading whitespace
        let start = node.start
        while (start > 2 && wrapped[start - 1] === ' ')
          start--
        ranges.push({ start, end: node.end })
      }
    },
  })

  if (ranges.length === 0)
    return jsx

  ranges.sort((a, b) => b.start - a.start)
  let result = wrapped
  for (const { start, end } of ranges)
    result = result.slice(0, start) + result.slice(end)

  // Unwrap the `<>…</>` we added
  return result.slice(2, result.length - 3)
}

/**
 * Collect all import declarations from the full file AST
 */
function collectImports(ast: t.File): Map<string, ImportInfo> {
  const imports = new Map<string, ImportInfo>()
  const importedNames = new Map<string, ImportInfo>()

  for (const node of ast.program.body) {
    if (node.type === 'ImportDeclaration') {
      const source = node.source.value
      const info: ImportInfo = {
        source,
        specifiers: [],
      }

      for (const spec of node.specifiers) {
        if (spec.type === 'ImportDefaultSpecifier') {
          info.specifiers.push({
            type: 'default',
            local: spec.local.name,
          })
          importedNames.set(spec.local.name, info)
        }
        else if (spec.type === 'ImportSpecifier') {
          const imported = spec.imported.type === 'Identifier'
            ? spec.imported.name
            : spec.imported.value
          info.specifiers.push({
            type: 'named',
            local: spec.local.name,
            imported,
          })
          importedNames.set(spec.local.name, info)
        }
        else if (spec.type === 'ImportNamespaceSpecifier') {
          info.specifiers.push({
            type: 'namespace',
            local: spec.local.name,
          })
          importedNames.set(spec.local.name, info)
        }
      }

      imports.set(source, info)
    }
  }

  return importedNames
}

/**
 * Try to extract a type annotation string from a binding's declaration.
 * Accepts the full AST for resolving named type references (interfaces, type aliases).
 */
function extractTypeFromBinding(binding: any, fullAst?: t.File): string {
  if (!binding || !binding.path)
    return 'any'

  const node = binding.path.node

  // const x: Type = ...
  if (node.type === 'VariableDeclarator') {
    // Destructured: const { user }: { user: UserType } = obj
    if (node.id?.type === 'ObjectPattern') {
      const propName: string = binding.identifier?.name
      if (propName) {
        const resolved = resolveObjectPatternPropType(propName, node.id as t.ObjectPattern, fullAst)
        if (resolved !== 'any')
          return resolved
      }
    }
    else if (node.id?.typeAnnotation?.typeAnnotation) {
      return typeAnnotationToString(node.id.typeAnnotation.typeAnnotation)
    }
    // Infer from initializer (e.g. useState<T>(), arrow functions)
    return inferTypeFromVariableInit(binding, fullAst)
  }

  // function foo(x: string) or (x: string) => ...
  if (node.type === 'Identifier') {
    if (node.typeAnnotation?.typeAnnotation) {
      return typeAnnotationToString(node.typeAnnotation.typeAnnotation)
    }

    // Array pattern: const [x, setX] = useState<T>() or similar
    const parentNodeArr = binding.path.parent
    if (parentNodeArr?.type === 'ArrayPattern') {
      return inferTypeFromArrayPatternElement(binding)
    }
  }

  // Babel stores the binding path at the ObjectPattern level for each member.
  // Use binding.identifier.name to know which property we're resolving.
  if (node.type === 'ObjectPattern') {
    const propName: string = binding.identifier?.name
    if (propName) {
      const resolved = resolveObjectPatternPropType(propName, node as t.ObjectPattern, fullAst)
      if (resolved !== 'any')
        return resolved
    }
  }

  // function handleClick(e: React.MouseEvent) { ... }
  if (node.type === 'FunctionDeclaration') {
    return extractFunctionType(node)
  }

  // const { user, role } = someObj  (Babel puts binding.path at ObjectProperty)
  if (node.type === 'ObjectProperty') {
    const propName: string = binding.identifier?.name
    const objectPattern = binding.path.parent
    if (propName && objectPattern?.type === 'ObjectPattern') {
      const resolved = resolveObjectPatternPropType(
        propName,
        objectPattern as t.ObjectPattern,
        fullAst,
      )
      if (resolved !== 'any')
        return resolved
    }
  }

  return 'any'
}

/**
 * Resolve the type of a specific property name from an ObjectPattern that
 * may carry an inline type or a reference to an interface / type alias.
 */
function resolveObjectPatternPropType(
  propName: string,
  objectPattern: t.ObjectPattern,
  fullAst?: t.File,
): string {
  const rawAnnotation = objectPattern.typeAnnotation
  // Noop has no typeAnnotation property; only TSTypeAnnotation does
  if (!rawAnnotation || rawAnnotation.type !== 'TSTypeAnnotation')
    return 'any'
  const annotation = rawAnnotation.typeAnnotation
  if (!annotation)
    return 'any'

  // Inline object type: { user: UserType }
  if (annotation.type === 'TSTypeLiteral') {
    for (const member of annotation.members) {
      if (
        member.type === 'TSPropertySignature'
        && member.key.type === 'Identifier'
        && member.key.name === propName
      ) {
        if (member.typeAnnotation?.typeAnnotation) {
          return typeAnnotationToString(member.typeAnnotation.typeAnnotation)
        }
      }
    }
  }

  // Named reference: MyProps, FC<MyProps>, etc.
  if (annotation.type === 'TSTypeReference' && fullAst) {
    let typeName: string | null = null
    if (annotation.typeName.type === 'Identifier') {
      typeName = annotation.typeName.name
    }
    if (typeName) {
      return lookupPropertyInNamedType(typeName, propName, fullAst)
    }
  }

  return 'any'
}

/**
 * Find an interface or type alias by name in the file AST and look up
 * the type of a specific property.
 */
function lookupPropertyInNamedType(
  typeName: string,
  propName: string,
  ast: t.File,
): string {
  for (const node of ast.program.body) {
    // interface MyProps { user: UserType }
    if (node.type === 'TSInterfaceDeclaration' && node.id.name === typeName) {
      const found = findPropertyInTSMembers(node.body.body, propName)
      if (found !== 'any')
        return found

      // Handle extends: interface MyProps extends BaseProps
      if (node.extends) {
        for (const ext of node.extends) {
          if (ext.expression.type === 'Identifier') {
            const parent = lookupPropertyInNamedType(ext.expression.name, propName, ast)
            if (parent !== 'any')
              return parent
          }
        }
      }
    }

    // type MyProps = { user: UserType } | SomeOtherType
    if (node.type === 'TSTypeAliasDeclaration' && node.id.name === typeName) {
      const typeAnn = node.typeAnnotation
      if (typeAnn.type === 'TSTypeLiteral') {
        const found = findPropertyInTSMembers(typeAnn.members, propName)
        if (found !== 'any')
          return found
      }
      // type MyProps = BaseProps & { extra: string }
      if (typeAnn.type === 'TSIntersectionType') {
        for (const part of typeAnn.types) {
          if (part.type === 'TSTypeLiteral') {
            const found = findPropertyInTSMembers(part.members, propName)
            if (found !== 'any')
              return found
          }
          if (part.type === 'TSTypeReference' && part.typeName.type === 'Identifier') {
            const found = lookupPropertyInNamedType(part.typeName.name, propName, ast)
            if (found !== 'any')
              return found
          }
        }
      }
    }
  }
  return 'any'
}

/**
 * Search a list of TSTypeElement members for a specific property name
 */
function findPropertyInTSMembers(
  members: t.TSTypeElement[],
  propName: string,
): string {
  for (const member of members) {
    if (
      member.type === 'TSPropertySignature'
      && member.key.type === 'Identifier'
      && member.key.name === propName
    ) {
      if (member.typeAnnotation?.typeAnnotation) {
        return typeAnnotationToString(member.typeAnnotation.typeAnnotation)
      }
    }
    // Also handle optional properties: user?: UserType
    if (
      member.type === 'TSPropertySignature'
      && member.key.type === 'StringLiteral'
      && member.key.value === propName
    ) {
      if (member.typeAnnotation?.typeAnnotation) {
        return typeAnnotationToString(member.typeAnnotation.typeAnnotation)
      }
    }
  }
  return 'any'
}

/**
 * Infer type for a variable when there's no explicit annotation,
 * by inspecting the initializer. Handles both direct declarators and
 * array-pattern destructuring (e.g. useState<T>()).
 */
function inferTypeFromVariableInit(binding: any, _fullAst?: t.File): string {
  const declarator = binding.path.node as t.VariableDeclarator
  if (!declarator.init)
    return 'any'

  // Determine array element index when lhs is ArrayPattern
  // e.g. const [count, setCount] = useState<number>(0)
  let arrayElemIndex = -1
  if (declarator.id.type === 'ArrayPattern') {
    const identName: string = binding.identifier?.name
    if (identName) {
      arrayElemIndex = (declarator.id as t.ArrayPattern).elements.findIndex(
        el => el?.type === 'Identifier' && (el as t.Identifier).name === identName,
      )
    }
  }

  if (
    declarator.init.type === 'ArrowFunctionExpression'
    || declarator.init.type === 'FunctionExpression'
  ) {
    return extractFunctionType(declarator.init)
  }

  if (declarator.init.type === 'TSAsExpression') {
    return typeAnnotationToString((declarator.init as t.TSAsExpression).typeAnnotation)
  }

  if (declarator.init.type === 'CallExpression') {
    const call = declarator.init as t.CallExpression
    const typeParams = call.typeParameters as t.TSTypeParameterInstantiation | null

    const calleeName
      = call.callee.type === 'Identifier'
        ? call.callee.name
        : call.callee.type === 'MemberExpression' && call.callee.property.type === 'Identifier'
          ? call.callee.property.name
          : null

    if (calleeName === 'useState' && typeParams?.params?.[0]) {
      const stateType = typeAnnotationToString(typeParams.params[0])
      if (arrayElemIndex <= 0)
        return stateType
      if (arrayElemIndex === 1)
        return `React.Dispatch<React.SetStateAction<${stateType}>>`
    }

    // useRef<T>() → RefObject<T>
    if (calleeName === 'useRef' && typeParams?.params?.[0]) {
      const inner = typeAnnotationToString(typeParams.params[0])
      return `React.RefObject<${inner}>`
    }

    // Generic typed call: someFactory<MyType>() — use first type param
    if (arrayElemIndex <= 0 && typeParams?.params?.[0]) {
      return typeAnnotationToString(typeParams.params[0])
    }
  }

  return 'any'
}

// Kept for backwards compatibility; array bindings are now handled by inferTypeFromVariableInit
function inferTypeFromArrayPatternElement(_binding: any): string {
  return 'any'
}

/**
 * Extract a TypeScript function type signature from an arrow function,
 * function expression, or function declaration node.
 */
function extractFunctionType(fn: any): string {
  const paramList: any[] = fn.params ?? fn.parameters ?? []
  const params = paramList.map((param: any, i: number) => {
    if (param.type === 'Identifier') {
      const ann = param.typeAnnotation
      if (ann && ann.type === 'TSTypeAnnotation') {
        return `${param.name}: ${typeAnnotationToString(ann.typeAnnotation)}`
      }
      return `${param.name}: any`
    }
    // Default parameter: (x: T = defaultVal)
    if (param.type === 'AssignmentPattern' && param.left?.type === 'Identifier') {
      const ann = param.left.typeAnnotation
      if (ann && ann.type === 'TSTypeAnnotation') {
        return `${param.left.name}?: ${typeAnnotationToString(ann.typeAnnotation)}`
      }
      return `${param.left.name}?: any`
    }
    // Rest parameter: (...args: T[])
    if (param.type === 'RestElement' && param.argument?.type === 'Identifier') {
      const ann = param.typeAnnotation ?? param.argument.typeAnnotation
      if (ann && ann.type === 'TSTypeAnnotation') {
        return `...${param.argument.name}: ${typeAnnotationToString(ann.typeAnnotation)}`
      }
      return `...${param.argument.name}: any[]`
    }
    return `arg${i}: any`
  }).join(', ')

  const retAnn = fn.returnType ?? fn.typeAnnotation
  const retStr = (retAnn && retAnn.type === 'TSTypeAnnotation')
    ? typeAnnotationToString(retAnn.typeAnnotation)
    : 'void'

  return `(${params}) => ${retStr}`
}

/**
 * Convert a Babel TSType node to a readable string
 */
function typeAnnotationToString(typeNode: t.TSType | t.FlowType): string {
  if (!typeNode)
    return 'any'

  switch (typeNode.type) {
    case 'TSStringKeyword':
      return 'string'
    case 'TSNumberKeyword':
      return 'number'
    case 'TSBooleanKeyword':
      return 'boolean'
    case 'TSAnyKeyword':
      return 'any'
    case 'TSVoidKeyword':
      return 'void'
    case 'TSNullKeyword':
      return 'null'
    case 'TSUndefinedKeyword':
      return 'undefined'
    case 'TSArrayType':
      return `${typeAnnotationToString((typeNode as t.TSArrayType).elementType)}[]`
    case 'TSTypeReference': {
      const ref = typeNode as t.TSTypeReference
      if (ref.typeName.type === 'Identifier') {
        const params = ref.typeParameters?.params
        if (params && params.length > 0) {
          const paramStrs = params.map(p => typeAnnotationToString(p))
          return `${ref.typeName.name}<${paramStrs.join(', ')}>`
        }
        return ref.typeName.name
      }
      return 'any'
    }
    case 'TSUnionType': {
      const union = typeNode as t.TSUnionType
      if (!union.types)
        return 'any'
      return union.types.map(member => typeAnnotationToString(member)).join(' | ')
    }
    case 'TSIntersectionType': {
      const inter = typeNode as t.TSIntersectionType
      if (!inter.types)
        return 'any'
      return inter.types.map(member => typeAnnotationToString(member)).join(' & ')
    }
    case 'TSFunctionType': {
      // Cast to any to work around @babel/types version inconsistencies
      const func = typeNode as any
      const paramList: any[] = func.params ?? func.parameters ?? []
      const params = paramList.map((p: any, i: number) => {
        let paramName = `arg${i}`
        let paramType = 'any'
        if (p && p.type === 'Identifier') {
          paramName = p.name
          const ann = p.typeAnnotation
          if (ann && ann.type === 'TSTypeAnnotation') {
            paramType = typeAnnotationToString(ann.typeAnnotation)
          }
        }
        return `${paramName}: ${paramType}`
      }).join(', ')
      const ret = func.returnType ?? func.typeAnnotation
      const retStr = (ret && ret.type === 'TSTypeAnnotation')
        ? typeAnnotationToString(ret.typeAnnotation)
        : 'void'
      return `(${params}) => ${retStr}`
    }
    case 'TSTypeLiteral': {
      return 'Record<string, any>'
    }
    default:
      return 'any'
  }
}

/**
 * Collect function/arrow parameter names from a node inside the selection
 */
function collectFunctionParams(
  node: t.ArrowFunctionExpression | t.FunctionExpression,
  selectionStart: number,
  selectionEnd: number,
  localDeclarations: Set<string>,
): void {
  if (node.start != null && node.end != null
    && node.start >= selectionStart && node.end <= selectionEnd) {
    for (const param of node.params) {
      if (param.type === 'Identifier') {
        localDeclarations.add(param.name)
      }
      else if (param.type === 'ObjectPattern') {
        for (const prop of param.properties) {
          if (prop.type === 'ObjectProperty' && prop.value.type === 'Identifier') {
            localDeclarations.add(prop.value.name)
          }
        }
      }
    }
  }
}

/**
 * Find all identifiers used in the selected JSX that reference
 * variables declared outside the selection
 */
function findExternalDependencies(
  fullAst: t.File,
  selectionStart: number,
  selectionEnd: number,
): { props: Map<string, PropInfo>, usedImportNames: Set<string> } {
  const props = new Map<string, PropInfo>()
  const usedImportNames = new Set<string>()
  const importedNames = collectImports(fullAst)

  // Collect identifiers declared within the selection (locals)
  const localDeclarations = new Set<string>()

  traverse(fullAst, {
    // Capture local variable declarations inside the selection
    VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
      const node = path.node
      if (node.start != null && node.end != null
        && node.start >= selectionStart && node.end <= selectionEnd) {
        if (node.id.type === 'Identifier') {
          localDeclarations.add(node.id.name)
        }
        else if (node.id.type === 'ObjectPattern') {
          for (const prop of node.id.properties) {
            if (prop.type === 'ObjectProperty' && prop.value.type === 'Identifier') {
              localDeclarations.add(prop.value.name)
            }
            else if (prop.type === 'RestElement' && prop.argument.type === 'Identifier') {
              localDeclarations.add(prop.argument.name)
            }
          }
        }
        else if (node.id.type === 'ArrayPattern') {
          for (const elem of node.id.elements) {
            if (elem?.type === 'Identifier') {
              localDeclarations.add(elem.name)
            }
          }
        }
      }
    },

    // Capture arrow function / function params inside the selection
    // e.g., array.map((item) => ...)
    ArrowFunctionExpression(path: NodePath<t.ArrowFunctionExpression>) {
      collectFunctionParams(path.node, selectionStart, selectionEnd, localDeclarations)
    },
    FunctionExpression(path: NodePath<t.FunctionExpression>) {
      collectFunctionParams(path.node, selectionStart, selectionEnd, localDeclarations)
    },
  })

  // Now find all identifiers used inside the selection
  traverse(fullAst, {
    Identifier(path: NodePath<t.Identifier>) {
      const node = path.node
      if (node.start == null || node.end == null)
        return
      if (node.start < selectionStart || node.end > selectionEnd)
        return

      const name = node.name

      // Skip if it's a property key (obj.prop — skip `prop`)
      if (path.parent.type === 'MemberExpression' && path.parent.property === node && !path.parent.computed) {
        return
      }

      // Skip if it's a JSX attribute name
      if (path.parent.type === 'JSXAttribute') {
        return
      }

      // Skip values inside key={...} — React's key is not passed as a component prop
      if (path.parent.type === 'JSXExpressionContainer') {
        const grandParent = path.parentPath?.parent
        if (
          grandParent?.type === 'JSXAttribute'
          && (grandParent as t.JSXAttribute).name?.type === 'JSXIdentifier'
          && ((grandParent as t.JSXAttribute).name as t.JSXIdentifier).name === 'key'
        ) {
          return
        }
      }

      // For type-only references (TSTypeReference, TSQualifiedName) still track
      // type imports but don't treat them as value props
      if (path.parent.type === 'TSTypeReference'
        || path.parent.type === 'TSQualifiedName') {
        if (importedNames.has(name)) {
          usedImportNames.add(name)
        }
        return
      }

      // Skip locally declared variables
      if (localDeclarations.has(name)) {
        return
      }

      // Check if this is an imported name — check BEFORE globals so explicit
      // imports (e.g. `import { Response } from './response'`) take precedence
      // over browser globals with the same name.
      if (importedNames.has(name)) {
        usedImportNames.add(name)
        return
      }

      // Skip global identifiers
      if (GLOBAL_IDENTIFIERS.has(name)) {
        return
      }

      // Check if the binding is in an outer scope
      const binding = path.scope.getBinding(name)
      if (!binding) {
        return // unresolved — could be a global, skip
      }

      const bindingNode = binding.path.node
      if (bindingNode.start != null && bindingNode.end != null) {
        // If declared outside the selection, it's a prop
        if (bindingNode.start < selectionStart || bindingNode.end > selectionEnd) {
          if (!props.has(name)) {
            let type = 'any'
            try {
              type = extractTypeFromBinding(binding, fullAst)
            }
            catch { /* fallback to any */ }
            props.set(name, { name, type })
          }
        }
      }
    },

    // Handle JSX element names that aren't HTML tags (custom components)
    JSXIdentifier(path: NodePath<t.JSXIdentifier>) {
      const node = path.node
      if (node.start == null || node.end == null)
        return
      if (node.start < selectionStart || node.end > selectionEnd)
        return

      // Skip closing tags — they mirror opening tags
      if (path.parent.type === 'JSXClosingElement')
        return

      const name = node.name

      // HTML elements start with lowercase — skip them
      if (/^[a-z]/.test(name))
        return

      // Skip locals
      if (localDeclarations.has(name))
        return

      // Check imports BEFORE globals so explicit imports override browser globals
      if (importedNames.has(name)) {
        usedImportNames.add(name)
        return
      }

      // Skip globals
      if (GLOBAL_IDENTIFIERS.has(name))
        return

      // Otherwise it's a component from outer scope → prop
      const binding = path.scope.getBinding(name)
      if (binding) {
        const bindingNode = binding.path.node
        if (bindingNode.start != null && bindingNode.end != null) {
          if (bindingNode.start < selectionStart || bindingNode.end > selectionEnd) {
            if (!props.has(name)) {
              let type = 'any'
              try {
                type = extractTypeFromBinding(binding, fullAst)
              }
              catch { /* fallback to any */ }
              props.set(name, { name, type })
            }
          }
        }
      }
    },

    // Handle <Namespace.Component /> — track the root namespace as a used import
    JSXMemberExpression(path: NodePath<t.JSXMemberExpression>) {
      const node = path.node
      if (node.start == null || node.end == null)
        return
      if (node.start < selectionStart || node.end > selectionEnd)
        return
      // Skip closing elements (they duplicate opening)
      if (path.parent.type === 'JSXClosingElement')
        return

      // Walk down to the root identifier (A.B.C → A)
      let root: t.JSXMemberExpression | t.JSXIdentifier = node
      while (root.type === 'JSXMemberExpression') {
        root = (root as t.JSXMemberExpression).object
      }
      if (root.type === 'JSXIdentifier' && importedNames.has(root.name)) {
        usedImportNames.add(root.name)
      }
    },
  })

  return { props, usedImportNames }
}

/**
 * Collect every position in the full AST where each import local name is
 * referenced (both value and type positions).
 */
function collectAllImportUsagePositions(
  ast: t.File,
  importedNames: Map<string, ImportInfo>,
): Map<string, number[]> {
  const positions = new Map<string, number[]>()

  traverse(ast, {
    Identifier(path: NodePath<t.Identifier>) {
      const { node } = path
      if (node.start == null)
        return
      const name = node.name
      if (!importedNames.has(name))
        return
      // Skip property keys in member expressions: obj.prop
      if (path.parent.type === 'MemberExpression' && path.parent.property === node && !path.parent.computed)
        return
      // Skip JSX attribute names
      if (path.parent.type === 'JSXAttribute')
        return
      // Skip import declaration nodes themselves
      if (
        path.parent.type === 'ImportSpecifier'
        || path.parent.type === 'ImportDefaultSpecifier'
        || path.parent.type === 'ImportNamespaceSpecifier'
      ) {
        return
      }
      const list = positions.get(name) ?? []
      list.push(node.start)
      positions.set(name, list)
    },
    JSXIdentifier(path: NodePath<t.JSXIdentifier>) {
      const { node } = path
      if (node.start == null)
        return
      const name = node.name
      if (!importedNames.has(name))
        return
      if (path.parent.type === 'JSXClosingElement')
        return
      const list = positions.get(name) ?? []
      list.push(node.start)
      positions.set(name, list)
    },
  })

  return positions
}

/**
 * Returns ImportInfo entries whose every usage in the full file lies within
 * [selectionStart, selectionEnd]. These are safe to remove from the original
 * file — they should be moved into the extracted component's file instead.
 */
export function findImportsExclusiveToSelection(
  fullSource: string,
  selectionStart: number,
  selectionEnd: number,
): ImportInfo[] {
  const ast = parseFullFile(fullSource)
  const importedNames = collectImports(ast)
  const allPositions = collectAllImportUsagePositions(ast, importedNames)

  // Group ImportInfo by source, deduplicating specifiers
  const infoBySource = new Map<string, { info: ImportInfo, exclusiveSpecifiers: Set<string> }>()

  for (const [name, positions] of allPositions) {
    const originalImport = importedNames.get(name)
    if (!originalImport)
      continue
    const allInside = positions.length > 0
      && positions.every(pos => pos >= selectionStart && pos <= selectionEnd)
    if (!allInside)
      continue

    let entry = infoBySource.get(originalImport.source)
    if (!entry) {
      entry = { info: originalImport, exclusiveSpecifiers: new Set() }
      infoBySource.set(originalImport.source, entry)
    }
    entry.exclusiveSpecifiers.add(name)
  }

  const result: ImportInfo[] = []
  for (const { info, exclusiveSpecifiers } of infoBySource.values()) {
    const specifiers = info.specifiers.filter(s => exclusiveSpecifiers.has(s.local))
    if (specifiers.length > 0) {
      result.push({ source: info.source, specifiers })
    }
  }
  return result
}

/**
 * Remove specific import specifiers (or entire import declarations) from
 * source text. Returns the updated source string.
 * Handles partial removal (some specifiers stay) and full removal.
 */
export function removeImportsFromSource(
  source: string,
  importsToRemove: ImportInfo[],
): string {
  if (importsToRemove.length === 0)
    return source

  // Build a fast lookup: source → Set of local names to remove
  const removeMap = new Map<string, Set<string>>()
  for (const imp of importsToRemove) {
    const set = removeMap.get(imp.source) ?? new Set()
    for (const s of imp.specifiers) set.add(s.local)
    removeMap.set(imp.source, set)
  }

  const ast = parseFullFile(source)
  // Collect edits as { start, end, replacement } sorted reverse order
  const edits: Array<{ start: number, end: number, text: string }> = []

  for (const node of ast.program.body) {
    if (node.type !== 'ImportDeclaration')
      continue
    const toRemove = removeMap.get(node.source.value)
    if (!toRemove || toRemove.size === 0)
      continue
    if (node.start == null || node.end == null)
      continue

    const remaining = node.specifiers.filter((s) => {
      const local
        = s.type === 'ImportDefaultSpecifier' || s.type === 'ImportNamespaceSpecifier'
          ? s.local.name
          : (s as t.ImportSpecifier).local.name
      return !toRemove.has(local)
    })

    if (remaining.length === 0) {
      // Remove the entire import line (including trailing newline)
      let end = node.end
      if (source[end] === '\n')
        end++
      edits.push({ start: node.start, end, text: '' })
    }
    else {
      // Reconstruct import with only remaining specifiers
      const defaultSpec = remaining.find(s => s.type === 'ImportDefaultSpecifier') as t.ImportDefaultSpecifier | undefined
      const namespaceSpec = remaining.find(s => s.type === 'ImportNamespaceSpecifier') as t.ImportNamespaceSpecifier | undefined
      const namedSpecs = remaining.filter(s => s.type === 'ImportSpecifier') as t.ImportSpecifier[]

      const parts: string[] = []
      if (defaultSpec)
        parts.push(defaultSpec.local.name)
      if (namespaceSpec)
        parts.push(`* as ${namespaceSpec.local.name}`)
      if (namedSpecs.length > 0) {
        const names = namedSpecs.map((s) => {
          const imported = s.imported.type === 'Identifier' ? s.imported.name : s.imported.value
          return imported !== s.local.name ? `${imported} as ${s.local.name}` : s.local.name
        })
        parts.push(`{ ${names.join(', ')} }`)
      }

      const newImport = `import ${parts.join(', ')} from '${node.source.value}'`
      edits.push({ start: node.start, end: node.end, text: newImport })
    }
  }

  // Apply edits from end → start to preserve offsets
  edits.sort((a, b) => b.start - a.start)
  let result = source
  for (const edit of edits) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  }
  return result
}

/**
 * Main analysis function: given the full file source code and the
 * selection offsets, determine which variables are external dependencies
 * (props) and which imports are needed.
 */
export function analyzeSelection(
  fullSource: string,
  selectionStart: number,
  selectionEnd: number,
): AnalysisResult {
  const selectedText = fullSource.slice(selectionStart, selectionEnd)

  // Validate the selected text is valid JSX
  if (!isValidJsx(selectedText)) {
    return {
      props: [],
      requiredImports: [],
      isValidJsx: false,
      error: 'Selected text is not valid JSX',
    }
  }

  try {
    const fullAst = parseFullFile(fullSource)
    const importedNames = collectImports(fullAst)

    const { props, usedImportNames } = findExternalDependencies(
      fullAst,
      selectionStart,
      selectionEnd,
    )

    // Scan prop types for imported type references — e.g. if a prop has type
    // 'ChatMessage', and ChatMessage is imported, include that import.
    for (const prop of props.values()) {
      if (prop.type === 'any')
        continue
      for (const [importName] of importedNames) {
        // Match the import name as a whole word inside the type string
        const re = new RegExp(`\\b${importName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
        if (re.test(prop.type)) {
          usedImportNames.add(importName)
        }
      }
    }

    // Build required imports: group used import names by source
    const importsBySource = new Map<string, ImportInfo>()

    for (const name of usedImportNames) {
      const originalImport = importedNames.get(name)
      if (!originalImport)
        continue

      let existing = importsBySource.get(originalImport.source)
      if (!existing) {
        existing = { source: originalImport.source, specifiers: [] }
        importsBySource.set(originalImport.source, existing)
      }

      const spec = originalImport.specifiers.find(s => s.local === name)
      if (spec && !existing.specifiers.some(s => s.local === name)) {
        existing.specifiers.push(spec)
      }
    }

    return {
      props: Array.from(props.values()),
      requiredImports: Array.from(importsBySource.values()),
      isValidJsx: true,
    }
  }
  catch (err: any) {
    return {
      props: [],
      requiredImports: [],
      isValidJsx: false,
      error: `Failed to analyze: ${err.message}`,
    }
  }
}
