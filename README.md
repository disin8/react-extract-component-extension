# React extract component extension for VSCode

<a href="https://marketplace.visualstudio.com/items?itemName=disin8.react-extract-component" target="__blank"><img src="https://img.shields.io/visual-studio-marketplace/v/disin8.react-extract-component.svg?color=eee&amp;label=VS%20Code%20Marketplace&logo=visual-studio-code" alt="Visual Studio Marketplace Version" /></a>


## Configurations

| Key                                           | Description                                                                       | Type      | Default        |
| --------------------------------------------- | --------------------------------------------------------------------------------- | --------- | -------------- |
| `reactExtractComponent.fileNameConvention`    | Naming convention for generated component files                                   | `string`  | `"kebab-case"` |
| `reactExtractComponent.createComponentFolder` | Create a folder for the component with an index.ts barrel file                    | `boolean` | `false`        |
| `reactExtractComponent.propsInterfaceNaming`  | Naming pattern for props interfaces: IPrefix = I{Name}Props, Suffix = {Name}Props | `string`  | `"IPrefix"`    |

## Commands

| Command                         | Title                |
| ------------------------------- | -------------------- |
| `reactExtractComponent.extract` | Extract to component |

## License

[MIT](./LICENSE.md) License © 2026 [Dmitry Sinkevich](https://github.com/disin8)
