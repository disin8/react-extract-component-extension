import { defineConfig } from 'reactive-vscode'
import * as Meta from './generated/meta'

export const config = defineConfig<Meta.ScopedConfigKeyTypeMap>(Meta.scopedConfigs.scope)

export type FileNameConvention = 'PascalCase' | 'camelCase' | 'kebab-case'
export type PropsInterfaceNaming = 'IPrefix' | 'Suffix'
