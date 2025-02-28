import {
  ScalarsMap,
  ParsedScalarsMap,
  NamingConvention,
  ConvertFn,
  ConvertOptions,
  LoadedFragment,
  NormalizedScalarsMap,
  DeclarationKind,
} from './types';
import { DeclarationBlockConfig } from './utils';
import { ASTNode, FragmentDefinitionNode, OperationDefinitionNode } from 'graphql';
import { ImportDeclaration, FragmentImport } from './imports';
export interface BaseVisitorConvertOptions {
  useTypesPrefix?: boolean;
  useTypesSuffix?: boolean;
}
export interface ParsedConfig {
  scalars: ParsedScalarsMap;
  convert: ConvertFn;
  typesPrefix: string;
  typesSuffix: string;
  addTypename: boolean;
  nonOptionalTypename: boolean;
  externalFragments: LoadedFragment[];
  fragmentImports: ImportDeclaration<FragmentImport>[];
  immutableTypes: boolean;
  useTypeImports: boolean;
}
export interface RawConfig {
  /**
   * @description Makes scalars strict.
   *
   * If scalars are found in the schema that are not defined in `scalars`
   * an error will be thrown during codegen.
   * @default false
   *
   * @exampleMarkdown
   * ```yml
   * config:
   *   strictScalars: true
   * ```
   */
  strictScalars?: boolean;
  /**
   * @description Allows you to override the type that unknown scalars will have.
   * @default any
   *
   * @exampleMarkdown
   * ```yml
   * config:
   *   defaultScalarType: unknown
   * ```
   */
  defaultScalarType?: string;
  /**
   * @description Extends or overrides the built-in scalars and custom GraphQL scalars to a custom type.
   *
   * @exampleMarkdown
   * ```yml
   * config:
   *   scalars:
   *     DateTime: Date
   *     JSON: "{ [key: string]: any }"
   * ```
   */
  scalars?: ScalarsMap;
  /**
   * @default change-case-all#pascalCase
   * @description Allow you to override the naming convention of the output.
   * You can either override all namings, or specify an object with specific custom naming convention per output.
   * The format of the converter must be a valid `module#method`.
   * Allowed values for specific output are: `typeNames`, `enumValues`.
   * You can also use "keep" to keep all GraphQL names as-is.
   * Additionally you can set `transformUnderscore` to `true` if you want to override the default behavior,
   * which is to preserves underscores.
   *
   * Available case functions in `change-case-all` are `camelCase`, `capitalCase`, `constantCase`, `dotCase`, `headerCase`, `noCase`, `paramCase`, `pascalCase`, `pathCase`, `sentenceCase`, `snakeCase`, `lowerCase`, `localeLowerCase`, `lowerCaseFirst`, `spongeCase`, `titleCase`, `upperCase`, `localeUpperCase` and `upperCaseFirst`
   * [See more](https://github.com/btxtiger/change-case-all)
   *
   * @exampleMarkdown
   * ## Override All Names
   * ```yml
   * config:
   *   namingConvention: change-case-all#lowerCase
   * ```
   *
   * ## Upper-case enum values
   * ```yml
   * config:
   *   namingConvention:
   *     typeNames: change-case-all#pascalCase
   *     enumValues: change-case-all#upperCase
   * ```
   *
   * ## Keep names as is
   * ```yml
   * config:
   *   namingConvention: keep
   * ```
   *
   * ## Remove Underscores
   * ```yml
   * config:
   *   namingConvention:
   *     typeNames: change-case-all#pascalCase
   *     transformUnderscore: true
   * ```
   */
  namingConvention?: NamingConvention;
  /**
   * @default ""
   * @description Prefixes all the generated types.
   *
   * @exampleMarkdown
   * ```yml
   * config:
   *   typesPrefix: I
   * ```
   */
  typesPrefix?: string;
  /**
   * @default ""
   * @description Suffixes all the generated types.
   *
   * @exampleMarkdown
   * ```yml
   * config:
   *   typesSuffix: I
   * ```
   */
  typesSuffix?: string;
  /**
   * @default false
   * @description Does not add __typename to the generated types, unless it was specified in the selection set.
   *
   * @exampleMarkdown
   * ```yml
   * config:
   *   skipTypename: true
   * ```
   */
  skipTypename?: boolean;
  /**
   * @default false
   * @description Automatically adds `__typename` field to the generated types, even when they are not specified
   * in the selection set, and makes it non-optional
   *
   * @exampleMarkdown
   * ```yml
   * config:
   *   nonOptionalTypename: true
   * ```
   */
  nonOptionalTypename?: boolean;
  /**
   * @name useTypeImports
   * @type boolean
   * @default false
   * @description Will use `import type {}` rather than `import {}` when importing only types. This gives
   * compatibility with TypeScript's "importsNotUsedAsValues": "error" option
   *
   * @example
   * ```yml
   * config:
   *   useTypeImports: true
   * ```
   */
  useTypeImports?: boolean;
  /**
   * @ignore
   */
  externalFragments?: LoadedFragment[];
  /**
   * @ignore
   */
  fragmentImports?: ImportDeclaration<FragmentImport>[];
  /**
   * @ignore
   */
  globalNamespace?: boolean;
}
export declare class BaseVisitor<
  TRawConfig extends RawConfig = RawConfig,
  TPluginConfig extends ParsedConfig = ParsedConfig
> {
  protected _parsedConfig: TPluginConfig;
  protected _declarationBlockConfig: DeclarationBlockConfig;
  readonly scalars: NormalizedScalarsMap;
  constructor(rawConfig: TRawConfig, additionalConfig: Partial<TPluginConfig>);
  protected getVisitorKindContextFromAncestors(ancestors: ASTNode[]): string[];
  get config(): TPluginConfig;
  convertName(node: ASTNode | string, options?: BaseVisitorConvertOptions & ConvertOptions): string;
  getOperationSuffix(node: FragmentDefinitionNode | OperationDefinitionNode | string, operationType: string): string;
  getFragmentSuffix(node: FragmentDefinitionNode | string): string;
  getFragmentName(node: FragmentDefinitionNode | string): string;
  getFragmentVariableName(node: FragmentDefinitionNode | string): string;
  protected getPunctuation(_declarationKind: DeclarationKind): string;
}
