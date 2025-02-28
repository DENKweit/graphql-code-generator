import { TypeNode, VariableNode, NameNode, ValueNode } from 'graphql';
import { NormalizedScalarsMap, ConvertNameFn, ParsedEnumValuesMap } from './types';
import { BaseVisitorConvertOptions } from './base-visitor';
export interface InterfaceOrVariable {
  name?: NameNode;
  variable?: VariableNode;
  type: TypeNode;
  defaultValue?: ValueNode;
}
export declare class OperationVariablesToObject {
  protected _scalars: NormalizedScalarsMap;
  protected _convertName: ConvertNameFn<BaseVisitorConvertOptions>;
  protected _namespacedImportName: string | null;
  protected _enumNames: string[];
  protected _enumPrefix: boolean;
  protected _enumValues: ParsedEnumValuesMap;
  protected _applyCoercion: Boolean;
  constructor(
    _scalars: NormalizedScalarsMap,
    _convertName: ConvertNameFn<BaseVisitorConvertOptions>,
    _namespacedImportName?: string | null,
    _enumNames?: string[],
    _enumPrefix?: boolean,
    _enumValues?: ParsedEnumValuesMap,
    _applyCoercion?: Boolean
  );
  getName<TDefinitionType extends InterfaceOrVariable>(node: TDefinitionType): string;
  transform<TDefinitionType extends InterfaceOrVariable>(variablesNode: ReadonlyArray<TDefinitionType>): string;
  protected getScalar(name: string): string;
  protected transformVariable<TDefinitionType extends InterfaceOrVariable>(variable: TDefinitionType): string;
  wrapAstTypeWithModifiers(_baseType: string, _typeNode: TypeNode, _applyCoercion?: Boolean): string;
  protected formatFieldString(fieldName: string, isNonNullType: boolean, _hasDefaultValue: boolean): string;
  protected formatTypeString(fieldType: string, isNonNullType: boolean, hasDefaultValue: boolean): string;
  protected getPunctuation(): string;
}
