'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

const graphql = require('graphql');
const visitorPluginCommon = require('@graphql-codegen/visitor-plugin-common');
const autoBind = _interopDefault(require('auto-bind'));

class PythonOperationVariablesToObject extends visitorPluginCommon.OperationVariablesToObject {
    constructor(_scalars, _convertName, _namespacedImportName = null, _enumNames = [], _enumPrefix = true, _enumValues = {}) {
        super(_scalars, _convertName, _namespacedImportName, _enumNames, _enumPrefix, _enumValues);
    }
    clearOptional(str) {
        // const prefix = this._namespacedImportName ? `${this._namespacedImportName}.` : "";
        const rgx = new RegExp(`^Optional\\[(.*?)\\]$`, 'i');
        if (str.startsWith(`${this._namespacedImportName ? `${this._namespacedImportName}.` : ''}Optional`)) {
            return str.replace(rgx, '$1');
        }
        return str;
    }
    wrapAstTypeWithModifiers(baseType, typeNode) {
        const prefix = this._namespacedImportName ? `${this._namespacedImportName}.` : '';
        if (typeNode.kind === graphql.Kind.NON_NULL_TYPE) {
            const type = this.wrapAstTypeWithModifiers(baseType, typeNode.type);
            return this.clearOptional(type);
        }
        else if (typeNode.kind === graphql.Kind.LIST_TYPE) {
            const innerType = this.wrapAstTypeWithModifiers(baseType, typeNode.type);
            return `${prefix}Optional[List[${innerType}]]`;
        }
        else {
            return `${prefix}Optional["${baseType}"]`;
        }
    }
    formatFieldString(fieldName, isNonNullType, hasDefaultValue) {
        return fieldName;
    }
    getScalar(name) {
        const prefix = this._namespacedImportName ? `${this._namespacedImportName}.` : '';
        return `${prefix}Scalar${name}`;
    }
    formatTypeString(fieldType, isNonNullType, hasDefaultValue) {
        if (!hasDefaultValue && isNonNullType) {
            return this.clearOptional(fieldType);
        }
        return fieldType;
    }
    getPunctuation() {
        return '';
    }
}

function transformPythonComment(comment, indentLevel = 0) {
    if (!comment || comment === '') {
        return '';
    }
    if (visitorPluginCommon.isStringValueNode(comment)) {
        comment = comment.value;
    }
    comment = comment.split('*/').join('*\\/');
    let lines = comment.split('\n');
    if (lines.length === 1) {
        return visitorPluginCommon.indent(`# ${lines[0]}\n`, indentLevel);
    }
    lines = [`"""`, ...lines, `"""\n`];
    return lines.map(line => visitorPluginCommon.indent(line, indentLevel)).join('\n');
}
class PythonDeclarationBlock extends visitorPluginCommon.DeclarationBlock {
    constructor(_config) {
        super({
            enumNameValueSeparator: '=',
            ..._config,
        });
    }
    withComment(comment) {
        const nonEmptyComment = visitorPluginCommon.isStringValueNode(comment) ? !!comment.value : !!comment;
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

const flatMap = require('array.prototype.flatmap');
class PyVisitor extends visitorPluginCommon.BaseTypesVisitor {
    constructor(schema, pluginConfig, additionalConfig = {}) {
        super(schema, {
            ...pluginConfig,
            declarationKind: {
                scalar: 'scalar',
            },
        }, {
            ...additionalConfig,
            scalars: visitorPluginCommon.buildScalars(schema, pluginConfig.scalars, PYTHON_SCALARS, 'Any'),
            typenameAsString: visitorPluginCommon.getConfigValue(pluginConfig.typenameAsString, false),
        }, PYTHON_SCALARS);
        this.keywords = new Set(csharpKeywords);
        autoBind(this);
        const enumNames = Object.values(schema.getTypeMap())
            .filter(graphql.isEnumType)
            .map(type => type.name);
        this.setArgumentsTransformer(new PythonOperationVariablesToObject(this.scalars, this.convertName, null, enumNames, pluginConfig.enumPrefix, this.config.enumValues));
        this.setDeclarationBlockConfig({
            enumNameValueSeparator: ' =',
            ignoreExport: true,
        });
    }
    convertSafeName(node) {
        const name = typeof node === 'string' ? node : node.value;
        return this.keywords.has(name) ? `_${name}` : name;
    }
    getWrapperDefinitions() {
        return [];
    }
    getScalarsImports() {
        let typingImport = `from typing import Optional, List, Union, Any`;
        if (!this.config.typenameAsString) {
            typingImport += ', Literal';
        }
        return [typingImport, 'from enum import Enum', ...super.getScalarsImports()];
    }
    _getScalar(name) {
        return `Scalar${name}`;
    }
    get scalarsDefinition() {
        const allScalars = Object.keys(this.config.scalars).map(scalarName => {
            const scalarValue = this.config.scalars[scalarName].type;
            const scalarType = this._schema.getType(scalarName);
            const comment = scalarType && scalarType.astNode && scalarType.description
                ? transformPythonComment(scalarType.description, 0)
                : '';
            return comment + `Scalar${scalarName} = ${scalarValue}`;
        });
        return allScalars.join('\n') + '\n';
    }
    clearOptional(str) {
        if (str.startsWith('Optional')) {
            return str.replace(/Optional\[(.*?)\]$/, '$1');
        }
        return str;
    }
    getExportPrefix() {
        return '';
    }
    _getTypeForNode(node) {
        const typeAsString = node.name;
        if (this.scalars[typeAsString] || this.config.enumValues[typeAsString]) {
            return super._getTypeForNode(node);
        }
        else {
            return `"__GQL_CODEGEN_${super._getTypeForNode(node)}__"`;
        }
    }
    NamedType(node, key, parent, path, ancestors) {
        const name = super.NamedType(node, key, parent, path, ancestors);
        return `Optional[${name.includes('__GQL_CODEGEN') ? name : `"${name}"`}]`;
    }
    ListType(node) {
        return `Optional[${super.ListType(node)}]`;
    }
    wrapWithListType(str) {
        return `${this.config.immutableTypes ? 'List' : 'List'}[${str}]`;
    }
    NonNullType(node) {
        const baseValue = super.NonNullType(node);
        return this.clearOptional(baseValue);
    }
    getObjectTypeDeclarationBlock(node, originalNode) {
        const { type } = this._parsedConfig.declarationKind;
        const allFields = [...node.fields];
        if (this.config.addTypename) {
            const typename = node.name;
            const typeString = this.config.typenameAsString ? 'ScalarString' : `Literal["${typename}"]`;
            const type = this.config.nonOptionalTypename ? typeString : `Optional[${typeString}]`;
            allFields.unshift(visitorPluginCommon.indent(`__typename: ${type}`));
        }
        const interfacesNames = []; // originalNode.interfaces ? originalNode.interfaces.map(i => this.convertName(i)) : [];
        const declarationBlock = new PythonDeclarationBlock({
            ...this._declarationBlockConfig,
        })
            .export()
            .asKind('class')
            .withName(this.convertName(node))
            .withComment(node.description);
        if (type === 'interface' || type === 'class') {
            if (interfacesNames.length > 0) {
                declarationBlock.withContent(' extends ' + interfacesNames.join(', ') + (allFields.length > 0 ? ' ' : ' {}'));
            }
            declarationBlock.withBlock(this.mergeAllFields(allFields, false));
        }
        else {
            this.appendInterfacesAndFieldsToBlock(declarationBlock, interfacesNames, allFields);
        }
        return declarationBlock;
    }
    FieldDefinition(node, key, parent) {
        const typeString = node.type;
        const comment = this.getFieldComment(node);
        const { type } = this.config.declarationKind;
        return (comment +
            visitorPluginCommon.indent(`${this.config.immutableTypes ? 'readonly ' : ''}${this.convertSafeName(node.name)}: ${typeString}${this.getPunctuation(type)}`));
    }
    getInputObjectDeclarationBlock(node) {
        return new PythonDeclarationBlock(this._declarationBlockConfig)
            .export()
            .withDecorator('@dataclass')
            .asKind(this._parsedConfig.declarationKind.input)
            .withName(this.convertName(node))
            .withComment(node.description)
            .withBlock(node.fields
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore
            .sort((a, b) => {
            const aOptional = a.indexOf('Optional') > 0;
            const bOptional = b.indexOf('Optional') > 0;
            if (aOptional) {
                if (bOptional) {
                    return 0;
                }
                return 1;
            }
            if (bOptional) {
                if (aOptional) {
                    return 0;
                }
                return -1;
            }
            return 0;
        })
            .join('\n'));
    }
    getArgumentsObjectDeclarationBlock(node, name, field) {
        return new PythonDeclarationBlock(this._declarationBlockConfig)
            .export()
            .asKind(this._parsedConfig.declarationKind.arguments)
            .withName(this.convertName(name))
            .withComment(node.description)
            .withBlock(this._argumentsTransformer.transform(field.arguments));
    }
    getFieldComment(node) {
        let commentText = node.description;
        const deprecationDirective = node.directives.find((v) => v.name === 'deprecated');
        if (deprecationDirective) {
            const deprecationReason = this.getDeprecationReason(deprecationDirective);
            commentText = `${commentText ? `${commentText}\n` : ''}@deprecated ${deprecationReason}`;
        }
        const comment = transformPythonComment(commentText, 1);
        return comment;
    }
    InputValueDefinition(node) {
        const comment = transformPythonComment(node.description, 1);
        let valueDefinition = visitorPluginCommon.indent(`${this.convertSafeName(node.name)}: ${node.type}`);
        if (valueDefinition.indexOf('Optional') > 0) {
            valueDefinition = valueDefinition + ' = None';
        }
        return comment + valueDefinition;
    }
    buildEnumValuesBlock(typeName, values) {
        return values
            .map(enumOption => {
            const optionName = this.convertName(enumOption, {
                useTypesPrefix: false,
                transformUnderscore: true,
            });
            const comment = transformPythonComment(enumOption.description, 1);
            let enumValue = enumOption.name;
            if (this.config.enumValues[typeName] &&
                this.config.enumValues[typeName].mappedValues &&
                typeof this.config.enumValues[typeName].mappedValues[enumValue] !== 'undefined') {
                enumValue = this.config.enumValues[typeName].mappedValues[enumValue];
            }
            return (comment +
                visitorPluginCommon.indent(`${this.convertSafeName(optionName)}${this._declarationBlockConfig.enumNameValueSeparator} ${visitorPluginCommon.wrapWithSingleQuotes(enumValue)}`));
        })
            .join('\n');
    }
    getInterfaceTypeDeclarationBlock(node, originalNode) {
        const declarationBlock = new PythonDeclarationBlock({})
            .export()
            .asKind(this._parsedConfig.declarationKind.interface)
            .withName(this.convertName(node))
            .withComment(node.description);
        return declarationBlock.withBlock(node.fields.join('\n'));
    }
    mergeInterfaces(interfaces) {
        if (interfaces.length === 0)
            return '';
        return `(${interfaces.join(', ')})`;
    }
    _buildTypeImport(identifier, source) {
        return `from ${source} import ${identifier}`;
    }
    handleEnumValueMapper(typeIdentifier, importIdentifier, sourceIdentifier, sourceFile) {
        const importStatement = this._buildTypeImport(importIdentifier || sourceIdentifier, sourceFile);
        if (importIdentifier !== sourceIdentifier || sourceIdentifier !== typeIdentifier) {
            return [importStatement, `${typeIdentifier} = ${sourceIdentifier}`];
        }
        return [importStatement];
    }
    getEnumsImports() {
        return flatMap(Object.keys(this.config.enumValues), enumName => {
            const mappedValue = this.config.enumValues[enumName];
            if (mappedValue.sourceFile) {
                return this.handleEnumValueMapper(mappedValue.typeIdentifier, mappedValue.importIdentifier, mappedValue.sourceIdentifier, mappedValue.sourceFile);
            }
            return [];
        }).filter(a => a);
    }
    getDataclassesImports() {
        return ['from dataclasses import dataclass'];
    }
    EnumTypeDefinition(node) {
        const enumName = node.name;
        // In case of mapped external enum string
        if (this.config.enumValues[enumName] && this.config.enumValues[enumName].sourceFile) {
            return '';
        }
        const enumTypeName = this.convertName(node, { useTypesPrefix: this.config.enumPrefix });
        return new PythonDeclarationBlock(this._declarationBlockConfig)
            .export()
            .asKind('enum')
            .withName(enumTypeName)
            .withComment(node.description)
            .withBlock(this.buildEnumValuesBlock(enumName, node.values)).string;
    }
    UnionTypeDefinition(node, key, parent) {
        const originalNode = parent[key];
        const possibleTypes = originalNode.types
            .map(t => (this.scalars[t.name.value] ? this._getScalar(t.name.value) : this._getTypeForNode(t)))
            .join(', ');
        return new PythonDeclarationBlock(this._declarationBlockConfig)
            .export()
            .asKind('union')
            .withName(this.convertName(node))
            .withComment(node.description)
            .withContent(possibleTypes).string;
    }
    getPunctuation(declarationKind) {
        return '';
    }
}

class TsIntrospectionVisitor extends PyVisitor {
    constructor(schema, pluginConfig = {}, typesToInclude) {
        super(schema, pluginConfig);
        this.typesToInclude = [];
        this.typesToInclude = typesToInclude;
        autoBind(this);
    }
    DirectiveDefinition() {
        return null;
    }
    ObjectTypeDefinition(node, key, parent) {
        const name = node.name;
        if (this.typesToInclude.some(type => type.name === name)) {
            return super.ObjectTypeDefinition(node, key, parent);
        }
        return null;
    }
    EnumTypeDefinition(node) {
        const name = node.name;
        if (this.typesToInclude.some(type => type.name === name)) {
            return super.EnumTypeDefinition(node);
        }
        return null;
    }
}

const plugin = (schema, documents, config) => {
    const visitor = new PyVisitor(schema, config);
    const printedSchema = graphql.printSchema(schema);
    const astNode = graphql.parse(printedSchema);
    const visitorResult = graphql.visit(astNode, { leave: visitor });
    const introspectionDefinitions = includeIntrospectionDefinitions(schema, documents, config);
    const scalars = visitor.scalarsDefinition;
    return {
        prepend: [
            ...visitor.getEnumsImports(),
            ...visitor.getScalarsImports(),
            ...visitor.getDataclassesImports(),
            ...visitor.getWrapperDefinitions(),
        ],
        content: ['', scalars, ...visitorResult.definitions, ...introspectionDefinitions].join('\n'),
    };
};
function includeIntrospectionDefinitions(schema, documents, config) {
    const typeInfo = new graphql.TypeInfo(schema);
    const usedTypes = [];
    const documentsVisitor = graphql.visitWithTypeInfo(typeInfo, {
        Field() {
            const type = graphql.getNamedType(typeInfo.getType());
            if (graphql.isIntrospectionType(type) && !usedTypes.includes(type)) {
                usedTypes.push(type);
            }
        },
    });
    documents.forEach(doc => graphql.visit(doc.document, documentsVisitor));
    const typesToInclude = [];
    usedTypes.forEach(type => {
        collectTypes(type);
    });
    const visitor = new TsIntrospectionVisitor(schema, config, typesToInclude);
    const result = graphql.visit(graphql.parse(graphql.printIntrospectionSchema(schema)), { leave: visitor });
    // recursively go through each `usedTypes` and their children and collect all used types
    // we don't care about Interfaces, Unions and others, but Objects and Enums
    function collectTypes(type) {
        if (typesToInclude.includes(type)) {
            return;
        }
        typesToInclude.push(type);
        if (graphql.isObjectType(type)) {
            const fields = type.getFields();
            Object.keys(fields).forEach(key => {
                const field = fields[key];
                const type = graphql.getNamedType(field.type);
                collectTypes(type);
            });
        }
    }
    return result.definitions;
}

exports.PyVisitor = PyVisitor;
exports.PythonOperationVariablesToObject = PythonOperationVariablesToObject;
exports.TsIntrospectionVisitor = TsIntrospectionVisitor;
exports.includeIntrospectionDefinitions = includeIntrospectionDefinitions;
exports.plugin = plugin;
//# sourceMappingURL=index.cjs.js.map
