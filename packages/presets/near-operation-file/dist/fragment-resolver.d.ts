import { Types } from '@graphql-codegen/plugin-helpers';
import {
  FragmentImport,
  LoadedFragment,
  ParsedConfig,
  ImportDeclaration,
} from '@graphql-codegen/visitor-plugin-common';
import { DocumentNode, FragmentDefinitionNode, GraphQLSchema } from 'graphql';
import { DocumentImportResolverOptions } from './resolve-document-imports';
export interface NearOperationFileParsedConfig extends ParsedConfig {
  importTypesNamespace?: string;
  dedupeOperationSuffix: boolean;
  omitOperationSuffix: boolean;
  fragmentVariablePrefix: string;
  fragmentVariableSuffix: string;
}
export declare type FragmentRegistry = {
  [fragmentName: string]: {
    filePath: string;
    onType: string;
    node: FragmentDefinitionNode;
    imports: Array<FragmentImport>;
  };
};
/**
 *  Builds a fragment "resolver" that collects `externalFragments` definitions and `fragmentImportStatements`
 */
export default function buildFragmentResolver<T>(
  collectorOptions: DocumentImportResolverOptions,
  presetOptions: Types.PresetFnArgs<T>,
  schemaObject: GraphQLSchema
): (
  generatedFilePath: string,
  documentFileContent: DocumentNode
) => {
  externalFragments: LoadedFragment<{
    level: number;
  }>[];
  fragmentImports: ImportDeclaration<FragmentImport>[];
};
