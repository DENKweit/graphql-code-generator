import { NormalizedScalarsMap } from './types';
import { DeclarationBlockConfig } from './utils';
import { GraphQLSchema, FragmentDefinitionNode, OperationDefinitionNode } from 'graphql';
import { SelectionSetToObject } from './selection-set-to-object';
import { OperationVariablesToObject } from './variables-to-object';
import { BaseVisitor } from './base-visitor';
import { ParsedTypesConfig, RawTypesConfig } from './base-types-visitor';
export interface ParsedDocumentsConfig extends ParsedTypesConfig {
  addTypename: boolean;
  preResolveTypes: boolean;
  globalNamespace: boolean;
  operationResultSuffix: string;
  dedupeOperationSuffix: boolean;
  omitOperationSuffix: boolean;
  namespacedImportName: string | null;
  exportFragmentSpreadSubTypes: boolean;
  skipTypeNameForRoot: boolean;
  experimentalFragmentVariables: boolean;
}
export interface RawDocumentsConfig extends RawTypesConfig {
  /**
   * @default false
   * @description Avoid using `Pick` and resolve the actual primitive type of all selection set.
   *
   * @exampleMarkdown
   * ```yml
   * plugins
   *   config:
   *     preResolveTypes: true
   * ```
   */
  preResolveTypes?: boolean;
  /**
   * @default false
   * @description Avoid adding `__typename` for root types. This is ignored when a selection explictly specifies `__typename`.
   *
   * @exampleMarkdown
   * ```yml
   * plugins
   *   config:
   *     skipTypeNameForRoot: true
   * ```
   */
  skipTypeNameForRoot?: boolean;
  /**
   * @default false
   * @description Puts all generated code under `global` namespace. Useful for Stencil integration.
   *
   * @exampleMarkdown
   * ```yml
   * plugins
   *   config:
   *     globalNamespace: true
   * ```
   */
  globalNamespace?: boolean;
  /**
   * @default ""
   * @description Adds a suffix to generated operation result type names
   */
  operationResultSuffix?: string;
  /**
   * @default false
   * @description Set this configuration to `true` if you wish to make sure to remove duplicate operation name suffix.
   */
  dedupeOperationSuffix?: boolean;
  /**
   * @default false
   * @description Set this configuration to `true` if you wish to disable auto add suffix of operation name, like `Query`, `Mutation`, `Subscription`, `Fragment`.
   */
  omitOperationSuffix?: boolean;
  /**
   * @default false
   * @description If set to true, it will export the sub-types created in order to make it easier to access fields declared under fragment spread.
   */
  exportFragmentSpreadSubTypes?: boolean;
  /**
   * @default false
   * @description If set to true, it will enable support for parsing variables on fragments.
   */
  experimentalFragmentVariables?: boolean;
  /**
   * @ignore
   */
  namespacedImportName?: string;
}
export declare class BaseDocumentsVisitor<
  TRawConfig extends RawDocumentsConfig = RawDocumentsConfig,
  TPluginConfig extends ParsedDocumentsConfig = ParsedDocumentsConfig
> extends BaseVisitor<TRawConfig, TPluginConfig> {
  protected _schema: GraphQLSchema;
  protected _unnamedCounter: number;
  protected _variablesTransfomer: OperationVariablesToObject;
  protected _selectionSetToObject: SelectionSetToObject;
  protected _globalDeclarations: Set<string>;
  constructor(
    rawConfig: TRawConfig,
    additionalConfig: TPluginConfig,
    _schema: GraphQLSchema,
    defaultScalars?: NormalizedScalarsMap
  );
  getGlobalDeclarations(noExport?: boolean): string[];
  setSelectionSetHandler(handler: SelectionSetToObject): void;
  setDeclarationBlockConfig(config: DeclarationBlockConfig): void;
  setVariablesTransformer(variablesTransfomer: OperationVariablesToObject): void;
  get schema(): GraphQLSchema;
  get addTypename(): boolean;
  private handleAnonymousOperation;
  FragmentDefinition(node: FragmentDefinitionNode): string;
  protected applyVariablesWrapper(variablesBlock: string): string;
  OperationDefinition(node: OperationDefinitionNode): string;
}
