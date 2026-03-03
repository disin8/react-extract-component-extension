import { describe, expect, it } from 'vitest'
import { analyzeSelection, extractKeyExpressionFromJsx, findImportsExclusiveToSelection, isMultiRootJsx, isValidJsx, removeImportsFromSource, stripKeyPropFromJsx } from '../src/analyzer'
import { computeRelativeImport, getFileName, toCamelCase, toKebabCase } from '../src/file-utils'
import {
  generateComponentCode,
  generateComponentUsage,
  generateImportsCode,
  generateNewFileContent,
} from '../src/generator'

// ─── JSX Validation ─────────────────────────────────────────────────

describe('isValidJsx', () => {
  it('accepts simple JSX element', () => {
    expect(isValidJsx('<div>hello</div>')).toBe(true)
  })

  it('accepts JSX with expressions', () => {
    expect(isValidJsx('<div className={styles.container}>{user.name}</div>')).toBe(true)
  })

  it('accepts self-closing JSX', () => {
    expect(isValidJsx('<MyComponent foo={bar} />')).toBe(true)
  })

  it('accepts JSX fragment', () => {
    expect(isValidJsx('<><div /><span /></>')).toBe(true)
  })

  it('rejects invalid JSX', () => {
    expect(isValidJsx('<div>unclosed')).toBe(false)
  })

  it('rejects broken JSX tags', () => {
    expect(isValidJsx('<div><span></div>')).toBe(false)
  })

  it('accepts multiple sibling elements wrapped in fragment implicitly', () => {
    expect(isValidJsx('<div />')).toBe(true)
  })
})

// ─── Key prop extraction / stripping ──────────────────────────────────

describe('extractKeyExpressionFromJsx', () => {
  it('extracts expression key', () => {
    expect(extractKeyExpressionFromJsx('<li key={item.id}>text</li>')).toBe('item.id')
  })

  it('extracts string literal key', () => {
    expect(extractKeyExpressionFromJsx('<li key="abc">text</li>')).toBe('"abc"')
  })

  it('returns null when no key present', () => {
    expect(extractKeyExpressionFromJsx('<li className="x">text</li>')).toBeNull()
  })
})

describe('stripKeyPropFromJsx', () => {
  it('removes key={expr} leaving other props', () => {
    const result = stripKeyPropFromJsx('<div key={item.id} className="foo">hello</div>')
    expect(result).not.toContain('key=')
    expect(result).toContain('className="foo"')
  })

  it('returns unchanged JSX when no key present', () => {
    const input = '<div className="box">{children}</div>'
    expect(stripKeyPropFromJsx(input)).toBe(input)
  })

  it('handles key as the only prop', () => {
    const result = stripKeyPropFromJsx('<li key={i}>item</li>')
    expect(result).not.toContain('key=')
    expect(result).toContain('<li>')
  })
})

// ─── Multi-root JSX detection ───────────────────────────────────────

describe('isMultiRootJsx', () => {
  it('returns false for a single root element', () => {
    expect(isMultiRootJsx('<div>hello</div>')).toBe(false)
  })

  it('returns true for two sibling elements', () => {
    expect(isMultiRootJsx('<div>a</div>\n<div>b</div>')).toBe(true)
  })

  it('returns true for three siblings', () => {
    expect(isMultiRootJsx('<h1>Title</h1>\n<p>Text</p>\n<span>More</span>')).toBe(true)
  })

  it('returns false for whitespace-only text nodes between elements (single element)', () => {
    expect(isMultiRootJsx('  <div>only one</div>  ')).toBe(false)
  })

  it('returns false for a JSX fragment with one child', () => {
    expect(isMultiRootJsx('<><div>child</div></>')).toBe(false)
  })
})

// ─── Analyzer ───────────────────────────────────────────────────────

describe('analyzeSelection', () => {
  it('detects external variables as props', () => {
    const source = `
import React from 'react'

const MyPage = () => {
  const user = { name: 'Alice' }
  const styles = { container: 'box' }
  return (
    <div className={styles.container}>{user.name}</div>
  )
}
`
    const jsxStart = source.indexOf('<div className')
    const jsxEnd = source.indexOf('</div>') + '</div>'.length

    const result = analyzeSelection(source, jsxStart, jsxEnd)

    expect(result.isValidJsx).toBe(true)
    expect(result.props.length).toBe(2)

    const propNames = result.props.map(p => p.name).sort()
    expect(propNames).toEqual(['styles', 'user'])
  })

  it('ignores imports and marks them as required imports', () => {
    const source = `
import React from 'react'
import clsx from 'clsx'

const MyPage = () => {
  const active = true
  return (
    <div className={clsx('base', active && 'active')}>hello</div>
  )
}
`
    const jsxStart = source.indexOf('<div className')
    const jsxEnd = source.indexOf('</div>') + '</div>'.length

    const result = analyzeSelection(source, jsxStart, jsxEnd)

    expect(result.isValidJsx).toBe(true)

    // clsx should NOT be a prop — it's an import
    const propNames = result.props.map(p => p.name)
    expect(propNames).not.toContain('clsx')
    expect(propNames).toContain('active')

    // clsx should be in required imports
    const importSources = result.requiredImports.map(i => i.source)
    expect(importSources).toContain('clsx')
  })

  it('ignores global identifiers', () => {
    const source = `
const MyPage = () => {
  const data = [1, 2, 3]
  return (
    <div>{console.log('test')}{JSON.stringify(data)}</div>
  )
}
`
    const jsxStart = source.indexOf('<div>')
    const jsxEnd = source.indexOf('</div>') + '</div>'.length

    const result = analyzeSelection(source, jsxStart, jsxEnd)

    const propNames = result.props.map(p => p.name)
    expect(propNames).not.toContain('console')
    expect(propNames).not.toContain('JSON')
    expect(propNames).toContain('data')
  })

  it('ignores locally declared variables inside selection', () => {
    const source = `
const MyPage = () => {
  const items = ['a', 'b']
  return (
    <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>
  )
}
`
    const jsxStart = source.indexOf('<ul>')
    const jsxEnd = source.indexOf('</ul>') + '</ul>'.length

    const result = analyzeSelection(source, jsxStart, jsxEnd)

    const propNames = result.props.map(p => p.name)

    expect(propNames).not.toContain('item')
    expect(propNames).toContain('items')
  })

  it('extracts type annotations when available', () => {
    const source = `
const MyPage = () => {
  const count: number = 5
  const name: string = 'hello'
  return (
    <div>{count} - {name}</div>
  )
}
`
    const jsxStart = source.indexOf('<div>')
    const jsxEnd = source.indexOf('</div>') + '</div>'.length

    const result = analyzeSelection(source, jsxStart, jsxEnd)

    const countProp = result.props.find(p => p.name === 'count')
    const nameProp = result.props.find(p => p.name === 'name')

    expect(countProp?.type).toBe('number')
    expect(nameProp?.type).toBe('string')
  })

  it('infers types from named interface via destructured props', () => {
    const source = `
interface PageProps {
  user: UserType
  onClick: () => void
  count: number
}

const MyPage = ({ user, onClick, count }: PageProps) => {
  return (
    <div onClick={onClick}>{user.name} - {count}</div>
  )
}
`
    const jsxStart = source.indexOf('<div ')
    const jsxEnd = source.indexOf('</div>') + '</div>'.length

    const result = analyzeSelection(source, jsxStart, jsxEnd)

    const userProp = result.props.find(p => p.name === 'user')
    const onClickProp = result.props.find(p => p.name === 'onClick')
    const countProp = result.props.find(p => p.name === 'count')

    expect(userProp?.type).toBe('UserType')
    expect(onClickProp?.type).toBe('() => void')
    expect(countProp?.type).toBe('number')
  })

  it('infers types from inline destructured object type', () => {
    const source = `
const MyPage = ({ title, active }: { title: string; active: boolean }) => {
  return (
    <div className={active ? 'on' : 'off'}>{title}</div>
  )
}
`
    const jsxStart = source.indexOf('<div ')
    const jsxEnd = source.indexOf('</div>') + '</div>'.length

    const result = analyzeSelection(source, jsxStart, jsxEnd)

    const titleProp = result.props.find(p => p.name === 'title')
    const activeProp = result.props.find(p => p.name === 'active')

    expect(titleProp?.type).toBe('string')
    expect(activeProp?.type).toBe('boolean')
  })

  it('infers state type from useState<T>', () => {
    const source = `
import { useState } from 'react'

const MyPage = () => {
  const [count, setCount] = useState<number>(0)
  return (
    <div>{count}</div>
  )
}
`
    const jsxStart = source.indexOf('<div>')
    const jsxEnd = source.indexOf('</div>') + '</div>'.length

    const result = analyzeSelection(source, jsxStart, jsxEnd)

    const countProp = result.props.find(p => p.name === 'count')
    expect(countProp?.type).toBe('number')
  })

  it('infers function type from arrow function variable declaration', () => {
    const source = `
const MyPage = () => {
  const handleClick = (e: MouseEvent) => {
    console.log(e)
  }
  return (
    <button onClick={handleClick}>click</button>
  )
}
`
    const jsxStart = source.indexOf('<button')
    const jsxEnd = source.indexOf('</button>') + '</button>'.length

    const result = analyzeSelection(source, jsxStart, jsxEnd)

    const prop = result.props.find(p => p.name === 'handleClick')
    expect(prop?.type).toBe('(e: MouseEvent) => void')
  })

  it('infers function type from function declaration', () => {
    const source = `
function handleSubmit(data: FormData): boolean {
  return true
}

const MyForm = () => {
  return (
    <form onSubmit={handleSubmit}></form>
  )
}
`
    const jsxStart = source.indexOf('<form')
    const jsxEnd = source.indexOf('</form>') + '</form>'.length

    const result = analyzeSelection(source, jsxStart, jsxEnd)

    const prop = result.props.find(p => p.name === 'handleSubmit')
    expect(prop?.type).toBe('(data: FormData) => boolean')
  })

  it('ignores key prop value as a component prop', () => {
    const source = `
const MyList = () => {
  const itemId = 'abc'
  const label = 'Hello'
  return (
    <div key={itemId}>{label}</div>
  )
}
`
    const jsxStart = source.indexOf('<div')
    const jsxEnd = source.indexOf('</div>') + '</div>'.length

    const result = analyzeSelection(source, jsxStart, jsxEnd)

    const propNames = result.props.map(p => p.name)
    expect(propNames).not.toContain('itemId')
    expect(propNames).toContain('label')
  })

  it('tracks namespace imports from JSX member expressions', () => {
    const source = `
import * as Icons from './icons'

const MyPage = () => {
  return (
    <Icons.Home />
  )
}
`
    const jsxStart = source.indexOf('<Icons.Home')
    const jsxEnd = source.indexOf('/>') + '/>'.length

    const result = analyzeSelection(source, jsxStart, jsxEnd)

    const importSources = result.requiredImports.map(i => i.source)
    expect(importSources).toContain('./icons')
  })

  it('prefers explicit imports over global identifiers with the same name', () => {
    const source = `
import { Response } from '@/components/elements/response'
import { sanitizeText } from '@/lib/utils'

const MyComp = () => {
  const text = 'hello'
  return (
    <Response>{sanitizeText(text)}</Response>
  )
}
`
    const jsxStart = source.indexOf('<Response>')
    const jsxEnd = source.indexOf('</Response>') + '</Response>'.length

    const result = analyzeSelection(source, jsxStart, jsxEnd)

    const importSources = result.requiredImports.map(i => i.source)
    expect(importSources).toContain('@/components/elements/response')
    expect(importSources).toContain('@/lib/utils')

    const propNames = result.props.map(p => p.name)
    expect(propNames).toContain('text')
  })

  it('includes type imports referenced in prop types', () => {
    const source = `
import type { ChatMessage } from '@/lib/types'

const PurePreviewMessage = ({ message }: { message: ChatMessage }) => {
  return (
    <div>{message.text}</div>
  )
}
`
    const jsxStart = source.indexOf('<div>')
    const jsxEnd = source.indexOf('</div>') + '</div>'.length

    const result = analyzeSelection(source, jsxStart, jsxEnd)

    const msgProp = result.props.find(p => p.name === 'message')
    expect(msgProp?.type).toBe('ChatMessage')

    const importSources = result.requiredImports.map(i => i.source)
    expect(importSources).toContain('@/lib/types')
  })

  it('returns error for invalid JSX selection', () => {
    const source = `const x = <div><span></div>`

    const result = analyzeSelection(source, 12, source.length)

    expect(result.isValidJsx).toBe(false)
    expect(result.error).toBeDefined()
  })
})

// ─── Import Exclusivity ─────────────────────────────────────────────

describe('findImportsExclusiveToSelection', () => {
  it('detects import used only inside selection', () => {
    const source = `
import clsx from 'clsx'
import React from 'react'

const Page = () => {
  return (
    <div className={clsx('a', 'b')}>hello</div>
  )
}
`
    const jsxStart = source.indexOf('<div')
    const jsxEnd = source.indexOf('</div>') + '</div>'.length
    const result = findImportsExclusiveToSelection(source, jsxStart, jsxEnd)
    const sources = result.map(i => i.source)
    expect(sources).toContain('clsx')
    expect(sources).not.toContain('react')
  })

  it('does not flag imports also used outside the selection', () => {
    const source = `
import clsx from 'clsx'

const Page = () => {
  const extra = clsx('outside')
  return (
    <div className={clsx('a')}>hello</div>
  )
}
`
    const jsxStart = source.indexOf('<div')
    const jsxEnd = source.indexOf('</div>') + '</div>'.length
    const result = findImportsExclusiveToSelection(source, jsxStart, jsxEnd)
    const sources = result.map(i => i.source)
    expect(sources).not.toContain('clsx')
  })

  it('detects type imports used only inside selection', () => {
    const source = `
import type { ButtonProps } from './button'

const Page = () => {
  return (
    <div data-x={null as unknown as ButtonProps}>hi</div>
  )
}
`
    const jsxStart = source.indexOf('<div')
    const jsxEnd = source.indexOf('</div>') + '</div>'.length
    const result = findImportsExclusiveToSelection(source, jsxStart, jsxEnd)
    const sources = result.map(i => i.source)
    expect(sources).toContain('./button')
  })
})

describe('removeImportsFromSource', () => {
  it('removes a fully exclusive import line', () => {
    const source = `import clsx from 'clsx'\nimport React from 'react'\n\nconst x = 1\n`
    const result = removeImportsFromSource(source, [
      { source: 'clsx', specifiers: [{ type: 'default', local: 'clsx' }] },
    ])
    expect(result).not.toContain('clsx')
    expect(result).toContain('import React from')
  })

  it('removes only specified named specifiers, keeping others', () => {
    const source = `import { useState, useEffect } from 'react'\n\nconst x = 1\n`
    const result = removeImportsFromSource(source, [
      { source: 'react', specifiers: [{ type: 'named', local: 'useState', imported: 'useState' }] },
    ])
    expect(result).not.toContain('useState')
    expect(result).toContain('useEffect')
    expect(result).toContain('from \'react\'')
  })

  it('removes whole import when all specifiers are gone', () => {
    const source = `import { useState } from 'react'\n\nconst x = 1\n`
    const result = removeImportsFromSource(source, [
      { source: 'react', specifiers: [{ type: 'named', local: 'useState', imported: 'useState' }] },
    ])
    expect(result).not.toContain('react')
  })
})

// ─── Code Generation ────────────────────────────────────────────────

describe('generateComponentCode', () => {
  it('wraps multiple root elements in a Fragment', () => {
    const code = generateComponentCode({
      componentName: 'MyComp',
      jsxFragment: '<div>first</div>\n<div>second</div>',
      wrapInFragment: true,
      props: [],
      requiredImports: [],
      propsInterfaceNaming: 'IPrefix',
      isTypeScript: true,
    })
    expect(code).toContain('<>')
    expect(code).toContain('</>')
    expect(code).toContain('<div>first</div>')
    expect(code).toContain('<div>second</div>')
  })

  it('generates component with props and interface (IPrefix)', () => {
    const code = generateComponentCode({
      componentName: 'UserCard',
      jsxFragment: '<div>{user.name}</div>',
      props: [
        { name: 'user', type: 'UserType' },
        { name: 'onClick', type: '() => void' },
      ],
      requiredImports: [],
      propsInterfaceNaming: 'IPrefix',
      isTypeScript: true,
    })

    expect(code).toContain('interface IUserCardProps')
    expect(code).toContain('user: UserType')
    expect(code).toContain('onClick: () => void')
    expect(code).toContain('const UserCard = ({ user, onClick }: IUserCardProps) => (')
    expect(code).toContain('<div>{user.name}</div>')
  })

  it('generates component with Suffix naming', () => {
    const code = generateComponentCode({
      componentName: 'UserCard',
      jsxFragment: '<div>{user.name}</div>',
      props: [{ name: 'user', type: 'any' }],
      requiredImports: [],
      propsInterfaceNaming: 'Suffix',
      isTypeScript: true,
    })

    expect(code).toContain('interface UserCardProps')
  })

  it('generates JS component without types', () => {
    const code = generateComponentCode({
      componentName: 'UserCard',
      jsxFragment: '<div>{user.name}</div>',
      props: [{ name: 'user', type: 'any' }],
      requiredImports: [],
      propsInterfaceNaming: 'IPrefix',
      isTypeScript: false,
    })

    expect(code).not.toContain('interface')
    expect(code).toContain('const UserCard = ({ user }) => (')
  })

  it('generates component without props', () => {
    const code = generateComponentCode({
      componentName: 'Logo',
      jsxFragment: '<img src="/logo.png" />',
      props: [],
      requiredImports: [],
      propsInterfaceNaming: 'IPrefix',
      isTypeScript: true,
    })

    expect(code).toContain('const Logo = () => (')
    expect(code).not.toContain('interface')
  })
})

describe('generateComponentUsage', () => {
  it('generates self-closing tag without props', () => {
    const usage = generateComponentUsage('Logo', [])
    expect(usage).toBe('<Logo />')
  })

  it('generates tag with props', () => {
    const usage = generateComponentUsage('UserCard', [
      { name: 'user', type: 'any' },
      { name: 'styles', type: 'any' },
    ])
    expect(usage).toBe('<UserCard user={user} styles={styles} />')
  })

  it('puts key first when keyExpression provided', () => {
    const usage = generateComponentUsage('Item', [{ name: 'label', type: 'string' }], 'item.id')
    expect(usage).toBe('<Item key={item.id} label={label} />')
  })

  it('includes key on a no-props component', () => {
    const usage = generateComponentUsage('Row', [], 'row.id')
    expect(usage).toBe('<Row key={row.id} />')
  })
})

describe('generateImportsCode', () => {
  it('generates named imports', () => {
    const code = generateImportsCode([
      {
        source: 'react',
        specifiers: [
          { type: 'default', local: 'React' },
          { type: 'named', local: 'useState', imported: 'useState' },
        ],
      },
    ])
    expect(code).toContain('import React, { useState } from \'react\'')
  })

  it('generates namespace import', () => {
    const code = generateImportsCode([
      {
        source: './styles.module.css',
        specifiers: [{ type: 'namespace', local: 'styles' }],
      },
    ])
    expect(code).toContain('import * as styles from \'./styles.module.css\'')
  })

  it('returns empty string for no imports', () => {
    expect(generateImportsCode([])).toBe('')
  })
})

describe('generateNewFileContent', () => {
  it('generates full file with imports and export', () => {
    const content = generateNewFileContent({
      componentName: 'UserCard',
      jsxFragment: '<div>{user.name}</div>',
      props: [{ name: 'user', type: 'UserType' }],
      requiredImports: [
        {
          source: 'react',
          specifiers: [{ type: 'default', local: 'React' }],
        },
      ],
      propsInterfaceNaming: 'IPrefix',
      isTypeScript: true,
    })

    expect(content).toContain('import React from \'react\'')
    expect(content).toContain('interface IUserCardProps')
    expect(content).toContain('export default UserCard')
  })
})

// ─── File Utilities ─────────────────────────────────────────────────

describe('file-utils', () => {
  describe('toKebabCase', () => {
    it('converts PascalCase', () => {
      expect(toKebabCase('UserCard')).toBe('user-card')
    })

    it('converts multi-word PascalCase', () => {
      expect(toKebabCase('MyUserCardComponent')).toBe('my-user-card-component')
    })
  })

  describe('toCamelCase', () => {
    it('converts PascalCase to camelCase', () => {
      expect(toCamelCase('UserCard')).toBe('userCard')
    })
  })

  describe('getFileName', () => {
    it('pascalCase convention', () => {
      expect(getFileName('UserCard', 'PascalCase', 'tsx')).toBe('UserCard.tsx')
    })

    it('camelCase convention', () => {
      expect(getFileName('UserCard', 'camelCase', 'tsx')).toBe('userCard.tsx')
    })

    it('kebab-case convention', () => {
      expect(getFileName('UserCard', 'kebab-case', 'tsx')).toBe('user-card.tsx')
    })
  })

  describe('computeRelativeImport', () => {
    it('same directory', () => {
      const result = computeRelativeImport('/src/pages/Home.tsx', '/src/pages/UserCard.tsx')
      expect(result).toBe('./UserCard')
    })

    it('child directory', () => {
      const result = computeRelativeImport('/src/pages/Home.tsx', '/src/pages/components/UserCard.tsx')
      expect(result).toBe('./components/UserCard')
    })

    it('sibling directory', () => {
      const result = computeRelativeImport('/src/pages/Home.tsx', '/src/components/UserCard.tsx')
      expect(result).toBe('../components/UserCard')
    })
  })
})
