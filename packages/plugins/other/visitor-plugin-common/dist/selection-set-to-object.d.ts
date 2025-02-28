import {
  SelectionSetNode,
  FieldNode,
  FragmentSpreadNode,
  InlineFragmentNode,
  GraphQLNamedType,
  GraphQLSchema,
  SelectionNode,
  GraphQLObjectType,
} from 'graphql';
import { NormalizedScalarsMap, ConvertNameFn, LoadedFragment, GetFragmentSuffixFn } from './types';
import { BaseVisitorConvertOptions } from './base-visitor';
import { ParsedDocumentsConfig } from './base-documents-visitor';
import {
  LinkField,
  PrimitiveAliasedFields,
  PrimitiveField,
  BaseSelectionSetProcessor,
} from './selection-set-processor/base';
export declare class SelectionSetToObject<Config extends ParsedDocumentsConfig = ParsedDocumentsConfig> {
  protected _processor: BaseSelectionSetProcessor<any>;
  protected _scalars: NormalizedScalarsMap;
  protected _schema: GraphQLSchema;
  protected _convertName: ConvertNameFn<BaseVisitorConvertOptions>;
  protected _getFragmentSuffix: GetFragmentSuffixFn;
  protected _loadedFragments: LoadedFragment[];
  protected _config: Config;
  protected _parentSchemaType?: GraphQLNamedType;
  protected _selectionSet?: SelectionSetNode;
  protected _primitiveFields: PrimitiveField[];
  protected _primitiveAliasedFields: PrimitiveAliasedFields[];
  protected _linksFields: LinkField[];
  protected _queriedForTypename: boolean;
  constructor(
    _processor: BaseSelectionSetProcessor<any>,
    _scalars: NormalizedScalarsMap,
    _schema: GraphQLSchema,
    _convertName: ConvertNameFn<BaseVisitorConvertOptions>,
    _getFragmentSuffix: GetFragmentSuffixFn,
    _loadedFragments: LoadedFragment[],
    _config: Config,
    _parentSchemaType?: GraphQLNamedType,
    _selectionSet?: SelectionSetNode
  );
  createNext(parentSchemaType: GraphQLNamedType, selectionSet: SelectionSetNode): SelectionSetToObject;
  /**
   * traverse the inline fragment nodes recursively for colleting the selectionSets on each type
   */
  _collectInlineFragments(
    parentType: GraphQLNamedType,
    nodes: InlineFragmentNode[],
    types: Map<string, Array<SelectionNode | string>>
  ): any;
  protected _createInlineFragmentForFieldNodes(
    parentType: GraphQLNamedType,
    fieldNodes: FieldNode[]
  ): InlineFragmentNode;
  protected buildFragmentSpreadsUsage(spreads: FragmentSpreadNode[]): Record<string, string[]>;
  protected flattenSelectionSet(selections: ReadonlyArray<SelectionNode>): Map<string, Array<SelectionNode | string>>;
  private _appendToTypeMap;
  protected _buildGroupedSelections(): Record<string, string[]>;
  protected buildSelectionSetString(
    parentSchemaType: GraphQLObjectType,
    selectionNodes: Array<SelectionNode | string>
  ): string;
  protected isRootType(type: GraphQLObjectType): boolean;
  protected buildTypeNameField(
    type: GraphQLObjectType,
    nonOptionalTypename?: boolean,
    addTypename?: boolean,
    queriedForTypename?: boolean,
    skipTypeNameForRoot?: boolean
  ): {
    name: string;
    type: string;
  };
  protected getUnknownType(): string;
  transformSelectionSet(): string;
  transformFragmentSelectionSetToTypes(
    fragmentName: string,
    fragmentSuffix: string,
    declarationBlockConfig: any
  ): string;
  protected buildFragmentTypeName(name: string, suffix: string, typeName?: string): string;
}
