import { Kind, parse, printSchema, print, isScalarType, isInputObjectType, isEnumType, concatAST, visit } from 'graphql';
import { DeclarationBlock, isStringValueNode, indent, ClientSideBaseVisitor, buildScalars, DocumentMode, getBaseTypeNode, indentMultiline } from '@graphql-codegen/visitor-plugin-common';
import autoBind from 'auto-bind';
import { extname } from 'path';
import gql from 'graphql-tag';

function transformPythonComment(comment, indentLevel = 0) {
    if (!comment || comment === '') {
        return '';
    }
    if (isStringValueNode(comment)) {
        comment = comment.value;
    }
    comment = comment.split('*/').join('*\\/');
    let lines = comment.split('\n');
    if (lines.length === 1) {
        return indent(`# ${lines[0]}\n`, indentLevel);
    }
    lines = [`"""`, ...lines, `"""\n`];
    return lines.map(line => indent(line, indentLevel)).join('\n');
}
class PythonDeclarationBlock extends DeclarationBlock {
    constructor(_config) {
        super({
            enumNameValueSeparator: '=',
            ..._config,
        });
    }
    withComment(comment) {
        const nonEmptyComment = isStringValueNode(comment) ? !!comment.value : !!comment;
        if (nonEmptyComment) {
            this._comment = transformPythonComment(comment, 0);
        }
        return this;
    }
    get string() {
        let result = '';
        if (this._decorator) {
            result += this._decorator + '\n';
        }
        if (this._kind && this._kind !== 'union') {
            result += 'class ';
        }
        const name = this._name + (this._nameGenerics || '');
        if (name) {
            result += name;
        }
        switch (this._kind) {
            case 'enum':
                result += '(Enum)';
                break;
            case 'union':
                result += ' = Union[';
                break;
        }
        if (this._block) {
            if (this._content) {
                result += this._content;
            }
            const blockWrapper = this._ignoreBlockWrapper ? '' : this._config.blockWrapper;
            const before = ':' + blockWrapper;
            let after = blockWrapper;
            if (this._kind !== 'scalar') {
                after += `\n__GQL_CODEGEN_${name}__ = ${name}`;
            }
            const block = [before, this._block, after].filter(val => !!val).join('\n');
            if (this._methodName) {
                result += `${this._methodName}(${this._config.blockTransformer(block)})`;
            }
            else {
                result += this._config.blockTransformer(block);
            }
        }
        else if (this._content) {
            result += this._content;
            if (this._kind && this._kind === 'union') {
                result += ']';
            }
            result += `\n__GQL_CODEGEN_${name}__ = ${name}`;
        }
        return (this._comment ? this._comment : '') + result + '\n';
    }
}

const PYTHON_SCALARS = {
    ID: 'str',
    String: 'str',
    Boolean: 'bool',
    Int: 'int',
    Float: 'float',
};
const pythonNativeValueTypes = [
    'bool',
    'byte',
    'sbyte',
    'char',
    'decimal',
    'double',
    'float',
    'int',
    'uint',
    'long',
    'ulong',
    'short',
    'ushort',
];

function isValueType(type) {
    // Limitation: only checks the list of known built in value types
    // Eg .NET types and struct types won't be detected correctly
    return pythonNativeValueTypes.includes(type);
}
function getListTypeField(typeNode) {
    if (typeNode.kind === Kind.LIST_TYPE) {
        return {
            required: false,
            type: getListTypeField(typeNode.type),
        };
    }
    else if (typeNode.kind === Kind.NON_NULL_TYPE && typeNode.type.kind === Kind.LIST_TYPE) {
        return Object.assign(getListTypeField(typeNode.type), {
            required: true,
        });
    }
    else if (typeNode.kind === Kind.NON_NULL_TYPE) {
        return getListTypeField(typeNode.type);
    }
    else {
        return undefined;
    }
}
function getListTypeDepth(listType) {
    if (listType) {
        return getListTypeDepth(listType.type) + 1;
    }
    else {
        return 0;
    }
}
function getListInnerTypeNode(typeNode) {
    if (typeNode.kind === Kind.LIST_TYPE) {
        return getListInnerTypeNode(typeNode.type);
    }
    else if (typeNode.kind === Kind.NON_NULL_TYPE && typeNode.type.kind === Kind.LIST_TYPE) {
        return getListInnerTypeNode(typeNode.type);
    }
    else {
        return typeNode;
    }
}
function wrapFieldType(fieldType, listTypeField, listType = 'IEnumerable') {
    if (listTypeField) {
        const innerType = wrapFieldType(fieldType, listTypeField.type, listType);
        return `${listType}[${innerType}]`;
    }
    else {
        return fieldType.innerTypeName;
    }
}

class PythonFieldType {
    constructor(fieldType) {
        Object.assign(this, fieldType);
    }
    get innerTypeName() {
        const nullable = this.baseType.valueType && !this.baseType.required;
        return `${nullable ? 'Optional[' : ''}${this.baseType.type}${nullable ? ']' : ''}`;
    }
    get isOuterTypeRequired() {
        return this.listType ? this.listType.required : this.baseType.required;
    }
}

/**
 * C# keywords
 * https://docs.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/
 */
const csharpKeywords = [
    'abstract',
    'as',
    'and',
    'or',
    'not',
    'from',
    'None',
    'base',
    'bool',
    'break',
    'byte',
    'case',
    'catch',
    'char',
    'checked',
    'class',
    'const',
    'continue',
    'decimal',
    'default',
    'delegate',
    'do',
    'double',
    'else',
    'enum',
    'event',
    'explicit',
    'extern',
    'false',
    'finally',
    'fixed',
    'float',
    'for',
    'foreach',
    'goto',
    'if',
    'implicit',
    'in',
    'int',
    'interface',
    'internal',
    'is',
    'lock',
    'long',
    'namespace',
    'new',
    'null',
    'object',
    'operator',
    'out',
    'override',
    'params',
    'private',
    'protected',
    'public',
    'readonly',
    'ref',
    'return',
    'sbyte',
    'sealed',
    'short',
    'sizeof',
    'stackalloc',
    'static',
    'string',
    'struct',
    'switch',
    'this',
    'throw',
    'true',
    'try',
    'typeof',
    'uint',
    'ulong',
    'unchecked',
    'unsafe',
    'ushort',
    'using',
    'virtual',
    'void',
    'volatile',
    'while',
];

const defaultSuffix = 'GQL';
const lowerFirstLetter = str => str.charAt(0).toLowerCase() + str.slice(1);
const camelToSnakeCase = str => lowerFirstLetter(str).replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
class PythonOperationsVisitor extends ClientSideBaseVisitor {
    constructor(schema, fragments, rawConfig, documents) {
        super(schema, fragments, rawConfig, {
            schema: rawConfig.schema,
            subscriptionsSchema: rawConfig.schemaSubscriptions,
            querySuffix: rawConfig.querySuffix || defaultSuffix,
            mutationSuffix: rawConfig.mutationSuffix || defaultSuffix,
            subscriptionSuffix: rawConfig.subscriptionSuffix || defaultSuffix,
            scalars: buildScalars(schema, rawConfig.scalars, PYTHON_SCALARS),
            generateAsync: rawConfig.generateAsync,
        }, documents);
        this._operationsToInclude = [];
        this.keywords = new Set(csharpKeywords);
        this.overruleConfigSettings();
        autoBind(this);
        this._schemaAST = parse(printSchema(schema));
        this._usingNearFileOperations = true;
    }
    convertSafeName(node) {
        const name = typeof node === 'string' ? node : node.value;
        return this.keywords.has(name) ? `_${name}` : name;
    }
    // Some settings aren't supported with C#, overruled here
    overruleConfigSettings() {
        if (this.config.documentMode === DocumentMode.graphQLTag) {
            // C# operations does not (yet) support graphQLTag mode
            this.config.documentMode = DocumentMode.documentNode;
        }
    }
    _gql(node) {
        const fragments = this._transformFragments(node);
        const doc = this._prepareDocument([print(node), this._includeFragments(fragments)].join('\n'));
        return doc.replace(/"/g, '\\"');
    }
    _nonScalarPrefix() {
        return this._usingNearFileOperations ? 'Types.' : '';
    }
    _gqlInputSignature(variable) {
        const typeNode = variable.type;
        const innerType = getBaseTypeNode(typeNode);
        const schemaType = this._schema.getType(innerType.name.value);
        const name = variable.variable.name.value;
        const isInputAScalar = isScalarType(schemaType);
        const baseType = !isInputAScalar
            ? `${this._nonScalarPrefix()}${innerType.name.value}`
            : this.scalars[schemaType.name] || 'object';
        const listType = getListTypeField(typeNode);
        const required = getListInnerTypeNode(typeNode).kind === Kind.NON_NULL_TYPE;
        return {
            name: name,
            signature: !listType
                ? `${name}: ${baseType}${!required ? ' = None' : ''}`
                : `${name}: ${'List['.repeat(getListTypeDepth(listType))}${baseType}${']'.repeat(getListTypeDepth(listType))}`,
            value: isInputAScalar ? name : `to_dict(${name})`,
        };
    }
    _operationSuffix(operationType) {
        switch (operationType) {
            case 'query':
                return this.config.querySuffix;
            case 'mutation':
                return this.config.mutationSuffix;
            case 'subscription':
                return this.config.subscriptionSuffix;
            default:
                return defaultSuffix;
        }
    }
    getExecuteFunctionSignature(isAsync, node) {
        var _a;
        if (!node.name || !node.name.value) {
            return null;
        }
        this._collectedOperations.push(node);
        const documentVariableName = this.convertName(node, {
            suffix: this.config.documentVariableSuffix,
            prefix: this.config.documentVariablePrefix,
            useTypesPrefix: false,
        });
        const operationType = node.operation;
        const operationTypeSuffix = this.config.dedupeOperationSuffix && node.name.value.toLowerCase().endsWith(node.operation)
            ? ''
            : !operationType
                ? ''
                : operationType;
        const operationResultType = this.convertName(node, {
            suffix: operationTypeSuffix + this._parsedConfig.operationResultSuffix,
        });
        const operationVariablesTypes = this.convertName(node, {
            suffix: operationTypeSuffix + 'Variables',
        });
        this._operationsToInclude.push({
            node,
            documentVariableName,
            operationType,
            operationResultType,
            operationVariablesTypes,
        });
        const inputs = (_a = node.variableDefinitions) === null || _a === void 0 ? void 0 : _a.map(v => this._gqlInputSignature(v));
        const hasInputArgs = !!(inputs === null || inputs === void 0 ? void 0 : inputs.length);
        const inputSignatures = hasInputArgs ? inputs.map(sig => sig.signature).join(', ') : '';
        return `
${isAsync ? 'async ' : ''}def ${camelToSnakeCase(this.convertName(node)).toLowerCase()}(self${hasInputArgs ? ', ' : ''}${inputSignatures}, **kwargs):
`;
    }
    getExecuteFunctionBody(isAsync, node) {
        var _a;
        if (!node.name || !node.name.value) {
            return null;
        }
        this._collectedOperations.push(node);
        const documentVariableName = this.convertName(node, {
            suffix: this.config.documentVariableSuffix,
            prefix: this.config.documentVariablePrefix,
            useTypesPrefix: false,
        });
        const operationType = node.operation;
        const operationTypeSuffix = this.config.dedupeOperationSuffix && node.name.value.toLowerCase().endsWith(node.operation)
            ? ''
            : !operationType
                ? ''
                : operationType;
        const operationResultType = this.convertName(node, {
            suffix: operationTypeSuffix + this._parsedConfig.operationResultSuffix,
        });
        const operationVariablesTypes = this.convertName(node, {
            suffix: operationTypeSuffix + 'Variables',
        });
        this._operationsToInclude.push({
            node,
            documentVariableName,
            operationType,
            operationResultType,
            operationVariablesTypes,
        });
        const inputs = (_a = node.variableDefinitions) === null || _a === void 0 ? void 0 : _a.map(v => this._gqlInputSignature(v));
        const variables = `{
    ${inputs.map(v => `"${v.name}": ${v.value},`).join('\n      ')}
  }`;
        const resposeClass = `${this.convertName(node.name.value).replace(/_/g, '')}Response`;
        const content = `
variables=${variables}
variables_no_none = {k:v for k,v in variables.items() if v is not None}
${isAsync
            ? `
response_text_promise = self.__async_client.execute_async(
  _gql_${this._get_node_name(node)},
  variable_values=variables_no_none,
)
response_dict = await response_text_promise`
            : `
response_dict = self.__client.execute(
  _gql_${this._get_node_name(node)},
  variable_values=variables_no_none,
  upload_files=kwargs["upload_files"] if "upload_files" in kwargs else False
)`}

response_dict = remove_empty(response_dict)
ret: ${resposeClass} = from_dict(data_class=${resposeClass}, data=response_dict, config=Config(cast=[Enum], check_types=False))
return ret
`;
        // {"researchBox": GetDatapointResponse.researchBox}
        return [content].filter(a => a).join('\n');
    }
    getExecuteFunctionSubscriptionsSignature(isAsync, node) {
        var _a;
        if (!node.name || !node.name.value) {
            return null;
        }
        this._collectedOperations.push(node);
        const documentVariableName = this.convertName(node, {
            suffix: this.config.documentVariableSuffix,
            prefix: this.config.documentVariablePrefix,
            useTypesPrefix: false,
        });
        const operationType = node.operation;
        const operationTypeSuffix = this.config.dedupeOperationSuffix && node.name.value.toLowerCase().endsWith(node.operation)
            ? ''
            : !operationType
                ? ''
                : operationType;
        const operationResultType = this.convertName(node, {
            suffix: operationTypeSuffix + this._parsedConfig.operationResultSuffix,
        });
        const operationVariablesTypes = this.convertName(node, {
            suffix: operationTypeSuffix + 'Variables',
        });
        this._operationsToInclude.push({
            node,
            documentVariableName,
            operationType,
            operationResultType,
            operationVariablesTypes,
        });
        const inputs = (_a = node.variableDefinitions) === null || _a === void 0 ? void 0 : _a.map(v => this._gqlInputSignature(v));
        const hasInputArgs = !!(inputs === null || inputs === void 0 ? void 0 : inputs.length);
        const inputSignatures = hasInputArgs ? inputs.map(sig => sig.signature).join(', ') : '';
        return `
${isAsync ? 'async ' : ''}def ${camelToSnakeCase(this.convertName(node)).toLowerCase()}(self${hasInputArgs ? ', ' : ''}${inputSignatures}):
`;
    }
    getExecuteFunctionSubscriptionsBody(isAsync, node) {
        var _a;
        if (!node.name || !node.name.value) {
            return null;
        }
        this._collectedOperations.push(node);
        const documentVariableName = this.convertName(node, {
            suffix: this.config.documentVariableSuffix,
            prefix: this.config.documentVariablePrefix,
            useTypesPrefix: false,
        });
        const operationType = node.operation;
        const operationTypeSuffix = this.config.dedupeOperationSuffix && node.name.value.toLowerCase().endsWith(node.operation)
            ? ''
            : !operationType
                ? ''
                : operationType;
        const operationResultType = this.convertName(node, {
            suffix: operationTypeSuffix + this._parsedConfig.operationResultSuffix,
        });
        const operationVariablesTypes = this.convertName(node, {
            suffix: operationTypeSuffix + 'Variables',
        });
        this._operationsToInclude.push({
            node,
            documentVariableName,
            operationType,
            operationResultType,
            operationVariablesTypes,
        });
        const inputs = (_a = node.variableDefinitions) === null || _a === void 0 ? void 0 : _a.map(v => this._gqlInputSignature(v));
        const variables = `{
    ${inputs.map(v => `"${v.name}": ${v.value},`).join('\n      ')}
  }`;
        const resposeClass = `${this.convertName(node.name.value).replace(/_/g, '')}Response`;
        const content = isAsync
            ? `
async with self.__websocket_client as client:
  variables = ${variables}
  variables_no_none = {k:v for k,v in variables.items() if v is not None}
  generator = client.subscribe(
    _gql_${this._get_node_name(node)},
    variable_values=variables_no_none,
  )
  async for response_dict in generator:
    response_dict = remove_empty(response_dict)
    ret: ${resposeClass} = from_dict(data_class=${resposeClass}, data=response_dict, config=Config(cast=[Enum], check_types=False))
    yield ret
    `
            : `
variables = ${variables}
variables_no_none = {k:v for k,v in variables.items() if v is not None}
generator = self.__websocket_client.call(
  _gql_${this._get_node_name(node)},
  variables=variables_no_none,
  operation_name="${node.name.value}"
)

for response_dict in generator:
  response_dict = remove_empty(response_dict)
  ret: ${resposeClass} = from_dict(data_class=${resposeClass}, data=response_dict, config=Config(cast=[Enum], check_types=False))
  yield ret
`;
        return [content].filter(a => a).join('\n');
    }
    _get_node_name(node) {
        return `${this.convertName(node)}_${this._operationSuffix(node.operation)}`.toLowerCase();
    }
    getGQLVar(node, returnAsString) {
        return `_gql_${this._get_node_name(node)} = ${!returnAsString ? 'gql(' : ''}"""
${this._gql(node)}
"""${!returnAsString ? ')' : ''}
`;
    }
    resolveFieldType(typeNode, hasDefaultValue = false) {
        const innerType = getBaseTypeNode(typeNode);
        const schemaType = this._schema.getType(innerType.name.value);
        const listType = getListTypeField(typeNode);
        const required = getListInnerTypeNode(typeNode).kind === Kind.NON_NULL_TYPE;
        let result = null;
        if (isScalarType(schemaType)) {
            if (this.scalars[schemaType.name]) {
                const baseType = this.scalars[schemaType.name];
                result = new PythonFieldType({
                    baseType: {
                        type: baseType,
                        required,
                        valueType: isValueType(baseType),
                    },
                    listType,
                });
            }
            else {
                result = new PythonFieldType({
                    baseType: {
                        type: 'object',
                        required,
                        valueType: false,
                    },
                    listType,
                });
            }
        }
        else if (isInputObjectType(schemaType)) {
            result = new PythonFieldType({
                baseType: {
                    type: `${this._nonScalarPrefix()}${this.convertName(schemaType.name)}`,
                    required,
                    valueType: false,
                },
                listType,
            });
        }
        else if (isEnumType(schemaType)) {
            result = new PythonFieldType({
                baseType: {
                    type: `${this._nonScalarPrefix()}${this.convertName(schemaType.name)}`,
                    required,
                    valueType: true,
                },
                listType,
            });
        }
        else {
            result = new PythonFieldType({
                baseType: {
                    type: `${schemaType.name}`,
                    required,
                    valueType: false,
                },
                listType,
            });
        }
        if (hasDefaultValue) {
            // Required field is optional when default value specified, see #4273
            (result.listType || result.baseType).required = false;
        }
        return result;
    }
    _getResponseFieldRecursive(node, parentSchema, fieldAsFragment, prepend, addField) {
        switch (node.kind) {
            case Kind.OPERATION_DEFINITION: {
                return new PythonDeclarationBlock({})
                    .export()
                    .asKind('class')
                    .withDecorator('@dataclass')
                    .withName(`${this.convertName(prepend).replace(/_/g, '')}Response`)
                    .withBlock(node.selectionSet.selections
                    .map(opr => {
                    if (opr.kind !== Kind.FIELD) {
                        throw new Error(`Unknown kind; ${opr.kind} in OperationDefinitionNode`);
                    }
                    return this._getResponseFieldRecursive(opr, parentSchema, false);
                })
                    .join('\n')).string;
            }
            case Kind.FIELD: {
                const fieldSchema = parentSchema.fields.find(f => f.name.value === node.name.value);
                if (!fieldSchema) {
                    throw new Error(`Field schema not found; ${node.name.value}`);
                }
                const responseType = this.resolveFieldType(fieldSchema.type);
                if (!node.selectionSet) {
                    const responseTypeName = wrapFieldType(responseType, responseType.listType, 'List');
                    if (!fieldAsFragment) {
                        return indentMultiline([`${this.convertSafeName(node.name.value)}: "${responseTypeName}"`].join('\n') + '\n');
                    }
                    else {
                        return ''; // `${node.name.value}: "${responseTypeName}"` + '\n';
                    }
                }
                else {
                    const selectionBaseTypeName = `${responseType.baseType.type}Selection`;
                    const selectionType = Object.assign(new PythonFieldType(responseType), {
                        baseType: { type: selectionBaseTypeName },
                    });
                    const selectionTypeName = wrapFieldType(selectionType, selectionType.listType, 'List');
                    const innerClassSchema = this._schemaAST.definitions.find(d => {
                        return ((d.kind === Kind.OBJECT_TYPE_DEFINITION || d.kind === Kind.INTERFACE_TYPE_DEFINITION) &&
                            d.name.value === responseType.baseType.type);
                    });
                    if (!innerClassSchema) {
                        throw new Error(`innerClassSchema not found: ${node.name.value}, schema: ${innerClassSchema}, opr.kind: ${node.kind}`);
                    }
                    const fragmentTypes = [Kind.FRAGMENT_SPREAD, Kind.INLINE_FRAGMENT];
                    const isSomeChildFragments = node.selectionSet.selections.some(s => fragmentTypes.indexOf(s.kind) !== -1);
                    const nonFragmentChilds = node.selectionSet.selections.flatMap(s => (s.kind !== Kind.FIELD ? [] : s));
                    if (isSomeChildFragments) {
                        const ret = indentMultiline([
                            //  innerClassDefinition,
                            ...node.selectionSet.selections.map(s => {
                                return this._getResponseFieldRecursive(s, innerClassSchema, true, undefined, nonFragmentChilds);
                            }),
                            `${node.name.value}: List[Union[${node.selectionSet.selections
                                .flatMap(s => (s.kind === Kind.FIELD ? [] : s))
                                .map(s => {
                                var _a;
                                if (s.kind === Kind.INLINE_FRAGMENT) {
                                    return (_a = s.typeCondition) === null || _a === void 0 ? void 0 : _a.name.value;
                                }
                                else if (s.kind === Kind.FRAGMENT_SPREAD) {
                                    return s.name.value;
                                }
                                //return s.name.value;
                                throw Error('Unknown Type');
                            })
                                .join(', ')}]]`,
                        ].join('\n'));
                        return ret;
                    }
                    else {
                        if (!fieldAsFragment) {
                            const innerClassDefinition = new PythonDeclarationBlock({})
                                .asKind('class')
                                .withDecorator('@dataclass')
                                .withName(selectionBaseTypeName)
                                .withBlock(node.selectionSet.selections
                                .map(s => {
                                return this._getResponseFieldRecursive(s, innerClassSchema, false);
                            })
                                .join('\n')).string;
                            return indentMultiline([innerClassDefinition, `${this.convertSafeName(node.name.value)}: ${selectionTypeName}`].join('\n'));
                        }
                        return '';
                    }
                }
            }
            case Kind.FRAGMENT_SPREAD: {
                const fragmentSchema = this._fragments.find(f => f.name === node.name.value);
                if (!fragmentSchema) {
                    throw new Error(`Fragment schema not found: ${node.name.value}`);
                }
                const fragmentParentSchema = this._schemaAST.definitions.find(s => s.kind === Kind.OBJECT_TYPE_DEFINITION && s.name.value === fragmentSchema.node.typeCondition.name.value);
                if (!fragmentParentSchema) {
                    throw new Error(`Fragment schema not found: ${fragmentSchema.node.typeCondition.name.value}`);
                }
                const innerClassDefinition = new PythonDeclarationBlock({})
                    .asKind('class')
                    .withDecorator('@dataclass')
                    .withName(node.name.value)
                    .withBlock(fragmentSchema.node.selectionSet.selections
                    .map(s => {
                    return this._getResponseFieldRecursive(s, fragmentParentSchema, false);
                })
                    .join('\n')).string;
                return innerClassDefinition;
            }
            case Kind.INLINE_FRAGMENT: {
                const fragmentSchemaName = node.typeCondition.name.value;
                const fragmentSchema = this._schemaAST.definitions.find(s => s.kind === Kind.OBJECT_TYPE_DEFINITION && s.name.value === fragmentSchemaName);
                if (!fragmentSchema) {
                    throw new Error(`Fragment schema not found; ${fragmentSchemaName}`);
                }
                let block = '\n' +
                    node.selectionSet.selections
                        .map(s => {
                        return this._getResponseFieldRecursive(s, fragmentSchema, false);
                    })
                        .join('\n');
                if (addField) {
                    block =
                        block +
                            '\n' +
                            addField
                                .flatMap(s => {
                                return s.kind === Kind.FIELD &&
                                    node.selectionSet.selections
                                        .filter(s => s.kind === Kind.FIELD)
                                        .map((s) => s.name.value)
                                        .includes(s.name.value)
                                    ? []
                                    : this._getResponseFieldRecursive(s, fragmentSchema, false);
                            })
                                .join('\n');
                }
                const innerClassDefinition = new PythonDeclarationBlock({})
                    .asKind('class')
                    .withDecorator('@dataclass')
                    .withName(fragmentSchemaName)
                    .withBlock(block).string;
                if (addField) {
                    return innerClassDefinition + '\n';
                }
                return innerClassDefinition + '\n';
            }
        }
    }
    getResponseClass(node) {
        var _a, _b;
        const operationSchema = this._schemaAST.definitions.find(s => s.kind === Kind.OBJECT_TYPE_DEFINITION && s.name.value.toLowerCase() === node.operation);
        return this._getResponseFieldRecursive(node, operationSchema, false, (_b = (_a = node.name) === null || _a === void 0 ? void 0 : _a.value) !== null && _b !== void 0 ? _b : '');
    }
    OperationDefinition(node) {
        const ret = [];
        if (node.operation === 'subscription') {
            ret.push(`${this.getGQLVar(node, !this.config.generateAsync)}
${this.getResponseClass(node)}`);
            ret.push(`${indentMultiline(this.getExecuteFunctionSubscriptionsSignature(this.config.generateAsync, node), 1)}
${indentMultiline(this.getExecuteFunctionSubscriptionsBody(this.config.generateAsync, node), 2)}`);
        }
        else {
            ret.push(`${this.getGQLVar(node)}
${this.getResponseClass(node)}`);
            ret.push(`${indentMultiline(this.getExecuteFunctionSignature(this.config.generateAsync, node), 1)}
${indentMultiline(this.getExecuteFunctionBody(this.config.generateAsync, node), 2)}`);
        }
        return ret.join('=$(§%/(=)$§(%=)$§=(%=§$)%/HGJDGSDG=()§§');
    }
}

const getImports = (config) => {
    return `
from typing import Any, List, Dict, Optional, Union, AsyncGenerator, Type
from dataclasses import dataclass
from dataclasses import asdict
from gql import gql, Client as GqlClient
from gql.transport.aiohttp import AIOHTTPTransport
${config.generateAsync ? 'from gql.transport.websockets import WebsocketsTransport' : ''}
from gql.transport.requests import RequestsHTTPTransport
from dacite import from_dict, Config
from enum import Enum
import websocket
import uuid
import json

def remove_empty(dict_or_list):
    if isinstance(dict_or_list, dict):
        delete_keys = []
        for key, value in dict_or_list.items():
            if value == {}:
              delete_keys.append(key)
            else:
              dict_or_list[key] = remove_empty(value)  
        for key in delete_keys:
          del dict_or_list[key]
        return dict_or_list
    elif isinstance(dict_or_list, list):
        delete_indices = []
        for idx, object_in_list in enumerate(dict_or_list):
            if object_in_list == {}:
                delete_indices.append(idx)
            else:
              dict_or_list[idx] = remove_empty(object_in_list)
        for idx in sorted(delete_indices, reverse=True):
          del dict_or_list[idx]
        return dict_or_list
    else:
        return dict_or_list

def to_dict(obj):
  if isinstance(obj, dict):
    for k,v in obj.items():
      if v is None:
        del obj[k]
      else:
        obj[k] = to_dict(v)
    return obj
  elif isinstance(obj, list):
    new_list = []
    for objs in obj:
      if objs is not None:
        new_list.append(to_dict(objs))
    return new_list
  elif hasattr(type(obj), '__dataclass_fields__'):
    new_dict = {}
    for k,v in obj.__dict__.items():
      if v is not None:
        new_dict[k] = to_dict(v)
    return new_dict
  else:
    return obj


${!config.generateAsync
        ? `
# adapted from https://github.com/profusion/sgqlc/blob/master/sgqlc/endpoint/websocket.py
class WebsocketClient:
  def __init__(self, url, connection_payload, **ws_options):
    self.url = url
    self.connection_payload = connection_payload
    self.ws_options = ws_options
    self.keep_alives = ['ka']

  @staticmethod
  def generate_id() -> str:
      return str(uuid.uuid4())
  
  def _get_response(self, ws):
        '''Ignore any keep alive responses'''

        response = json.loads(ws.recv())
        while response['type'] in self.keep_alives:
            response = json.loads(ws.recv())
        return response
    
  def call(self, query: str, variables, operation_name):
    ws = websocket.create_connection(self.url,
                                          subprotocols=['graphql-ws'],
                                          **self.ws_options)
    try:
      init_id = self.generate_id()
      connection_setup_dict = {'type': 'connection_init', 'id': init_id}
      if self.connection_payload:
          connection_setup_dict['payload'] = self.connection_payload
      ws.send(json.dumps(connection_setup_dict))

      response = self._get_response(ws)
      if response['type'] != 'connection_ack':
          raise ValueError(
              f'Unexpected {response["type"]} '
              f'when waiting for connection ack'
          )
      # response does not always have an id
      if response.get('id', init_id) != init_id:
          raise ValueError(
              f'Unexpected id {response["id"]} '
              f'when waiting for connection ack'
          )

      query_id = self.generate_id()
      ws.send(json.dumps({'type': 'start',
                          'id': query_id,
                          'payload': {'query': query,
                                      'variables': variables,
                                      'operationName': operation_name}}))
      response = self._get_response(ws)
      while response['type'] != 'complete':
          if response['id'] != query_id:
              raise ValueError(
                  f'Unexpected id {response["id"]} '
                  f'when waiting for query results'
              )
          if response['type'] == 'data':
              yield response['payload']["data"]
          else:
              raise ValueError(f'Unexpected message {response} '
                                f'when waiting for query results')
          response = self._get_response(ws)

    finally:
        ws.close()
`
        : ''}
`;
};
const getClient = (config) => {
    return `
class Client:
  def __init__(self, url: str, ws_url: str, headers: Optional[Dict[str, Any]] = None, ws_connection_payload: Optional[Dict[str, Any]] = None, secure: bool = True):

    if "://" in url or "://" in ws_url:
      raise ValueError("pass url/ws_url without scheme! Example: '127.0.0.1:8080/graphql'")
    
    http_url = ("https://" if secure else "http://") + url
    ws_url = ("wss://" if secure else "ws://") + ws_url
    ${config.generateAsync
        ? `

    self.__async_transport = AIOHTTPTransport(url=http_url, headers=headers)
    self.__async_client = GqlClient(transport=self.__async_transport, fetch_schema_from_transport=False)

    self.__websocket_transport = WebsocketsTransport(url=ws_url, init_payload=headers)
    self.__websocket_client = GqlClient(transport=self.__websocket_transport, fetch_schema_from_transport=False)

    `
        : `
    self.__http_transport = AIOHTTPTransport(url=http_url, headers=headers)
    self.__client = GqlClient(transport=self.__http_transport, fetch_schema_from_transport=False)

    self.__websocket_client = WebsocketClient(url=ws_url, connection_payload=ws_connection_payload)

    `}
  `;
};
const plugin = (schema, documents, config) => {
    const allAst = concatAST(documents.map(v => v.document));
    const allFragments = [
        ...allAst.definitions.filter(d => d.kind === Kind.FRAGMENT_DEFINITION).map(fragmentDef => ({
            node: fragmentDef,
            name: fragmentDef.name.value,
            onType: fragmentDef.typeCondition.name.value,
            isExternal: false,
        })),
        ...(config.externalFragments || []),
    ];
    const visitor = new PythonOperationsVisitor(schema, allFragments, config, documents);
    const visitorResult = visit(allAst, { leave: visitor });
    const varAndMethodSep = '=$(§%/(=)$§(%=)$§=(%=§$)%/HGJDGSDG=()§§';
    const filteredReults = visitorResult.definitions.filter(t => typeof t === 'string');
    const vars = [];
    const methods = [];
    filteredReults.forEach(r => {
        const varAndMethod = r.split(varAndMethodSep, 2);
        vars.push(varAndMethod[0]);
        methods.push(varAndMethod[1]);
    });
    return {
        prepend: [],
        content: [getImports(config), ...vars, getClient(config), ...methods].filter(a => a).join('\n'),
    };
};
const addToSchema = gql `
  directive @namedClient(name: String!) on OBJECT | FIELD
`;
const validate = async (schema, documents, config, outputFile) => {
    if (extname(outputFile) !== '.py') {
        throw new Error(`Plugin "python-operations" requires extension to be ".py"!`);
    }
};

export { PythonOperationsVisitor, addToSchema, plugin, validate };
//# sourceMappingURL=index.esm.js.map
