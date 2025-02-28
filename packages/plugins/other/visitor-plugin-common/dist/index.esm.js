import { Kind, isScalarType, isEqualType, isListType, isNonNullType, isObjectType, isAbstractType, isEnumType, isInterfaceType, GraphQLObjectType, isUnionType, visit, print, isTypeSubTypeOf, SchemaMetaFieldDef, TypeMetaFieldDef } from 'graphql';
import { resolveExternalModuleAndFn, DetailedError, ApolloFederation, getBaseType, removeNonNullWrapper } from '@graphql-codegen/plugin-helpers';
import { pascalCase } from 'change-case-all';
import { extname, resolve, relative, dirname, join, isAbsolute, basename } from 'path';
import parse from 'parse-filepath';
import autoBind from 'auto-bind';
import flatMap from 'array.prototype.flatmap';
import { DepGraph } from 'dependency-graph';
import gqlTag from 'graphql-tag';
import { optimizeDocumentNode } from '@graphql-tools/optimize';
import { optimizeDocuments } from '@graphql-tools/relay-operation-optimizer';

const DEFAULT_SCALARS = {
    ID: 'string',
    String: 'string',
    Boolean: 'boolean',
    Int: 'number',
    Float: 'number',
};

function isExternalMapperType(m) {
    return !!m.import;
}
var MapperKind;
(function (MapperKind) {
    MapperKind[MapperKind["Namespace"] = 0] = "Namespace";
    MapperKind[MapperKind["Default"] = 1] = "Default";
    MapperKind[MapperKind["Regular"] = 2] = "Regular";
})(MapperKind || (MapperKind = {}));
function prepareLegacy(mapper) {
    const items = mapper.split('#');
    const isNamespace = items.length === 3;
    const isDefault = items[1].trim() === 'default' || items[1].startsWith('default ');
    const hasAlias = items[1].includes(' as ');
    return {
        items,
        isDefault,
        isNamespace,
        hasAlias,
    };
}
function prepare(mapper) {
    const [source, path] = mapper.split('#');
    const isNamespace = path.includes('.');
    const isDefault = path.trim() === 'default' || path.startsWith('default ');
    const hasAlias = path.includes(' as ');
    return {
        items: isNamespace ? [source, ...path.split('.')] : [source, path],
        isDefault,
        isNamespace,
        hasAlias,
    };
}
function isLegacyMode(mapper) {
    return mapper.split('#').length === 3;
}
function parseMapper(mapper, gqlTypeName = null, suffix) {
    if (isExternalMapper(mapper)) {
        const { isNamespace, isDefault, hasAlias, items } = isLegacyMode(mapper) ? prepareLegacy(mapper) : prepare(mapper);
        const mapperKind = isNamespace
            ? MapperKind.Namespace
            : isDefault
                ? MapperKind.Default
                : MapperKind.Regular;
        function handleAlias(isDefault = false) {
            const [importedType, aliasType] = items[1].split(/\s+as\s+/);
            const type = maybeSuffix(aliasType);
            return {
                importElement: isDefault ? type : `${importedType} as ${type}`,
                type: type,
            };
        }
        function maybeSuffix(type) {
            if (suffix) {
                return addSuffix(type, suffix);
            }
            return type;
        }
        function handle() {
            switch (mapperKind) {
                // ./my/module#Namespace#Identifier
                case MapperKind.Namespace: {
                    const [, ns, identifier] = items;
                    return {
                        type: `${ns}.${identifier}`,
                        importElement: ns,
                    };
                }
                case MapperKind.Default: {
                    // ./my/module#default as alias
                    if (hasAlias) {
                        return handleAlias(true);
                    }
                    const type = maybeSuffix(`${gqlTypeName}`);
                    // ./my/module#default
                    return {
                        importElement: type,
                        type,
                    };
                }
                case MapperKind.Regular: {
                    // ./my/module#Identifier as alias
                    if (hasAlias) {
                        return handleAlias();
                    }
                    const identifier = items[1];
                    const type = maybeSuffix(identifier);
                    // ./my/module#Identifier
                    return {
                        type,
                        importElement: suffix ? `${identifier} as ${type}` : type,
                    };
                }
            }
        }
        const { type, importElement } = handle();
        return {
            default: isDefault,
            isExternal: true,
            source: items[0],
            type,
            import: importElement.replace(/<(.*?)>/g, ''),
        };
    }
    return {
        isExternal: false,
        type: mapper,
    };
}
function addSuffix(element, suffix) {
    const generic = element.indexOf('<');
    if (generic === -1) {
        return `${element}${suffix}`;
    }
    return `${element.slice(0, generic)}${suffix}${element.slice(generic)}`;
}
function isExternalMapper(value) {
    return value.includes('#');
}
function transformMappers(rawMappers, mapperTypeSuffix) {
    const result = {};
    Object.keys(rawMappers).forEach(gqlTypeName => {
        const mapperDef = rawMappers[gqlTypeName];
        const parsedMapper = parseMapper(mapperDef, gqlTypeName, mapperTypeSuffix);
        result[gqlTypeName] = parsedMapper;
    });
    return result;
}
function buildMapperImport(source, types, useTypeImports) {
    if (!types || types.length === 0) {
        return null;
    }
    const defaultType = types.find(t => t.asDefault === true);
    let namedTypes = types.filter(t => !t.asDefault);
    if (useTypeImports) {
        if (defaultType) {
            // default as Baz
            namedTypes = [{ identifier: `default as ${defaultType.identifier}` }, ...namedTypes];
        }
        // { Foo, Bar as BarModel }
        const namedImports = namedTypes.length ? `{ ${namedTypes.map(t => t.identifier).join(', ')} }` : '';
        // { default as Baz, Foo, Bar as BarModel }
        return `import type ${[namedImports].filter(Boolean).join(', ')} from '${source}';`;
    }
    // { Foo, Bar as BarModel }
    const namedImports = namedTypes.length ? `{ ${namedTypes.map(t => t.identifier).join(', ')} }` : '';
    // Baz
    const defaultImport = defaultType ? defaultType.identifier : '';
    // Baz, { Foo, Bar as BarModel }
    return `import ${[defaultImport, namedImports].filter(Boolean).join(', ')} from '${source}';`;
}

const getConfigValue = (value, defaultValue) => {
    if (value === null || value === undefined) {
        return defaultValue;
    }
    return value;
};
function quoteIfNeeded(array, joinWith = ' & ') {
    if (array.length === 0) {
        return '';
    }
    else if (array.length === 1) {
        return array[0];
    }
    else {
        return `(${array.join(joinWith)})`;
    }
}
function block(array) {
    return array && array.length !== 0 ? '{\n' + array.join('\n') + '\n}' : '';
}
function wrapWithSingleQuotes(value, skipNumericCheck = false) {
    if (skipNumericCheck) {
        if (typeof value === 'number') {
            return `${value}`;
        }
        else {
            return `'${value}'`;
        }
    }
    if (typeof value === 'number' ||
        (typeof value === 'string' && !isNaN(parseInt(value)) && parseFloat(value).toString() === value)) {
        return `${value}`;
    }
    return `'${value}'`;
}
function breakLine(str) {
    return str + '\n';
}
function indent(str, count = 1) {
    return new Array(count).fill('  ').join('') + str;
}
function indentMultiline(str, count = 1) {
    const indentation = new Array(count).fill('  ').join('');
    const replaceWith = '\n' + indentation;
    return indentation + str.replace(/\n/g, replaceWith);
}
function transformComment(comment, indentLevel = 0, disabled = false) {
    if (!comment || comment === '' || disabled) {
        return '';
    }
    if (isStringValueNode(comment)) {
        comment = comment.value;
    }
    comment = comment.split('*/').join('*\\/');
    let lines = comment.split('\n');
    if (lines.length === 1) {
        return indent(`/** ${lines[0]} */\n`, indentLevel);
    }
    lines = ['/**', ...lines.map(line => ` * ${line}`), ' */\n'];
    return stripTrailingSpaces(lines.map(line => indent(line, indentLevel)).join('\n'));
}
class DeclarationBlock {
    constructor(_config) {
        this._config = _config;
        this._decorator = null;
        this._export = false;
        this._name = null;
        this._kind = null;
        this._methodName = null;
        this._content = null;
        this._block = null;
        this._nameGenerics = null;
        this._comment = null;
        this._ignoreBlockWrapper = false;
        this._config = {
            blockWrapper: '',
            blockTransformer: block => block,
            enumNameValueSeparator: ':',
            ...this._config,
        };
    }
    withDecorator(decorator) {
        this._decorator = decorator;
        return this;
    }
    export(exp = true) {
        if (!this._config.ignoreExport) {
            this._export = exp;
        }
        return this;
    }
    asKind(kind) {
        this._kind = kind;
        return this;
    }
    withComment(comment, disabled = false) {
        const nonEmptyComment = isStringValueNode(comment) ? !!comment.value : !!comment;
        if (nonEmptyComment && !disabled) {
            this._comment = transformComment(comment, 0);
        }
        return this;
    }
    withMethodCall(methodName, ignoreBlockWrapper = false) {
        this._methodName = methodName;
        this._ignoreBlockWrapper = ignoreBlockWrapper;
        return this;
    }
    withBlock(block) {
        this._block = block;
        return this;
    }
    withContent(content) {
        this._content = content;
        return this;
    }
    withName(name, generics = null) {
        this._name = name;
        this._nameGenerics = generics;
        return this;
    }
    get string() {
        let result = '';
        if (this._decorator) {
            result += this._decorator + '\n';
        }
        if (this._export) {
            result += 'export ';
        }
        if (this._kind) {
            let extra = '';
            let name = '';
            if (['type', 'const', 'var', 'let'].includes(this._kind)) {
                extra = '= ';
            }
            if (this._name) {
                name = this._name + (this._nameGenerics || '') + ' ';
            }
            result += this._kind + ' ' + name + extra;
        }
        if (this._block) {
            if (this._content) {
                result += this._content;
            }
            const blockWrapper = this._ignoreBlockWrapper ? '' : this._config.blockWrapper;
            const before = '{' + blockWrapper;
            const after = blockWrapper + '}';
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
        }
        else if (this._kind) {
            result += this._config.blockTransformer('{}');
        }
        return stripTrailingSpaces((this._comment ? this._comment : '') +
            result +
            (this._kind === 'interface' || this._kind === 'enum' || this._kind === 'namespace' || this._kind === 'function'
                ? ''
                : ';') +
            '\n');
    }
}
function getBaseTypeNode(typeNode) {
    if (typeNode.kind === Kind.LIST_TYPE || typeNode.kind === Kind.NON_NULL_TYPE) {
        return getBaseTypeNode(typeNode.type);
    }
    return typeNode;
}
function convertNameParts(str, func, removeUnderscore = false) {
    if (removeUnderscore) {
        return func(str);
    }
    return str
        .split('_')
        .map(s => func(s))
        .join('_');
}
function buildScalarsFromConfig(schema, config, defaultScalarsMapping = DEFAULT_SCALARS, defaultScalarType = 'any') {
    return buildScalars(schema, config.scalars, defaultScalarsMapping, config.strictScalars ? null : config.defaultScalarType || defaultScalarType);
}
function buildScalars(schema, scalarsMapping, defaultScalarsMapping = DEFAULT_SCALARS, defaultScalarType = 'any') {
    const result = {};
    Object.keys(defaultScalarsMapping).forEach(name => {
        result[name] = parseMapper(defaultScalarsMapping[name]);
    });
    if (schema) {
        const typeMap = schema.getTypeMap();
        Object.keys(typeMap)
            .map(typeName => typeMap[typeName])
            .filter(type => isScalarType(type))
            .map((scalarType) => {
            const name = scalarType.name;
            if (typeof scalarsMapping === 'string') {
                const value = parseMapper(scalarsMapping + '#' + name, name);
                result[name] = value;
            }
            else if (scalarsMapping && typeof scalarsMapping[name] === 'string') {
                const value = parseMapper(scalarsMapping[name], name);
                result[name] = value;
            }
            else if (scalarsMapping && scalarsMapping[name]) {
                result[name] = {
                    isExternal: false,
                    type: JSON.stringify(scalarsMapping[name]),
                };
            }
            else if (!defaultScalarsMapping[name]) {
                if (defaultScalarType === null) {
                    throw new Error(`Unknown scalar type ${name}. Please override it using the "scalars" configuration field!`);
                }
                result[name] = {
                    isExternal: false,
                    type: defaultScalarType,
                };
            }
        });
    }
    else if (scalarsMapping) {
        if (typeof scalarsMapping === 'string') {
            throw new Error('Cannot use string scalars mapping when building without a schema');
        }
        Object.keys(scalarsMapping).forEach(name => {
            if (typeof scalarsMapping[name] === 'string') {
                const value = parseMapper(scalarsMapping[name], name);
                result[name] = value;
            }
            else {
                result[name] = {
                    isExternal: false,
                    type: JSON.stringify(scalarsMapping[name]),
                };
            }
        });
    }
    return result;
}
function isStringValueNode(node) {
    return node && typeof node === 'object' && node.kind === Kind.STRING;
}
function isRootType(type, schema) {
    return (isEqualType(type, schema.getQueryType()) ||
        isEqualType(type, schema.getMutationType()) ||
        isEqualType(type, schema.getSubscriptionType()));
}
function getRootTypeNames(schema) {
    return [schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()]
        .filter(t => t)
        .map(t => t.name);
}
function stripMapperTypeInterpolation(identifier) {
    return identifier.trim().replace(/<{.*}>/, '');
}
const OMIT_TYPE = 'export type Omit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>;';
const REQUIRE_FIELDS_TYPE = `export type RequireFields<T, K extends keyof T> = { [X in Exclude<keyof T, K>]?: T[X] } & { [P in K]-?: NonNullable<T[P]> };`;
function mergeSelectionSets(selectionSet1, selectionSet2) {
    const newSelections = [...selectionSet1.selections];
    for (const selection2 of selectionSet2.selections) {
        if (selection2.kind === 'FragmentSpread') {
            newSelections.push(selection2);
            continue;
        }
        if (selection2.kind !== 'Field') {
            throw new TypeError('Invalid state.');
        }
        const match = newSelections.find(selection1 => selection1.kind === 'Field' && getFieldNodeNameValue(selection1) === getFieldNodeNameValue(selection2));
        if (match) {
            // recursively merge all selection sets
            if (match.kind === 'Field' && match.selectionSet && selection2.selectionSet) {
                mergeSelectionSets(match.selectionSet, selection2.selectionSet);
            }
            continue;
        }
        newSelections.push(selection2);
    }
    // replace existing selections
    selectionSet1.selections = newSelections;
}
const getFieldNodeNameValue = (node) => {
    return (node.alias || node.name).value;
};
function separateSelectionSet(selections) {
    return {
        fields: selections.filter(s => s.kind === Kind.FIELD),
        inlines: selections.filter(s => s.kind === Kind.INLINE_FRAGMENT),
        spreads: selections.filter(s => s.kind === Kind.FRAGMENT_SPREAD),
    };
}
function getPossibleTypes(schema, type) {
    if (isListType(type) || isNonNullType(type)) {
        return getPossibleTypes(schema, type.ofType);
    }
    else if (isObjectType(type)) {
        return [type];
    }
    else if (isAbstractType(type)) {
        return schema.getPossibleTypes(type);
    }
    return [];
}
function hasConditionalDirectives(field) {
    var _a;
    const CONDITIONAL_DIRECTIVES = ['skip', 'include'];
    return (_a = field.directives) === null || _a === void 0 ? void 0 : _a.some(directive => CONDITIONAL_DIRECTIVES.includes(directive.name.value));
}
function wrapTypeWithModifiers(baseType, type, options) {
    let currentType = type;
    const modifiers = [];
    while (currentType) {
        if (isNonNullType(currentType)) {
            currentType = currentType.ofType;
        }
        else {
            modifiers.push(options.wrapOptional);
        }
        if (isListType(currentType)) {
            modifiers.push(options.wrapArray);
            currentType = currentType.ofType;
        }
        else {
            break;
        }
    }
    return modifiers.reduceRight((result, modifier) => modifier(result), baseType);
}
function removeDescription(nodes) {
    return nodes.map(node => ({ ...node, description: undefined }));
}
function wrapTypeNodeWithModifiers(baseType, typeNode) {
    switch (typeNode.kind) {
        case Kind.NAMED_TYPE: {
            return `Maybe<${baseType}>`;
        }
        case Kind.NON_NULL_TYPE: {
            const innerType = wrapTypeNodeWithModifiers(baseType, typeNode.type);
            return clearOptional(innerType);
        }
        case Kind.LIST_TYPE: {
            const innerType = wrapTypeNodeWithModifiers(baseType, typeNode.type);
            return `Maybe<Array<${innerType}>>`;
        }
    }
}
function clearOptional(str) {
    const rgx = new RegExp(`^Maybe<(.*?)>$`, 'i');
    if (str.startsWith(`Maybe`)) {
        return str.replace(rgx, '$1');
    }
    return str;
}
function stripTrailingSpaces(str) {
    return str.replace(/ +\n/g, '\n');
}

function getKind(node) {
    if (typeof node === 'string') {
        return 'typeNames';
    }
    if (['EnumValueDefinition', 'EnumValue'].includes(node.kind)) {
        return 'enumValues';
    }
    return 'typeNames';
}
function getName(node) {
    if (node == null) {
        return undefined;
    }
    if (typeof node === 'string') {
        return node;
    }
    switch (node.kind) {
        case 'OperationDefinition':
        case 'Variable':
        case 'Argument':
        case 'FragmentSpread':
        case 'FragmentDefinition':
        case 'ObjectField':
        case 'Directive':
        case 'NamedType':
        case 'ScalarTypeDefinition':
        case 'ObjectTypeDefinition':
        case 'FieldDefinition':
        case 'InputValueDefinition':
        case 'InterfaceTypeDefinition':
        case 'UnionTypeDefinition':
        case 'EnumTypeDefinition':
        case 'EnumValueDefinition':
        case 'InputObjectTypeDefinition':
        case 'DirectiveDefinition': {
            return getName(node.name);
        }
        case 'Name': {
            return node.value;
        }
        case 'Field': {
            return getName(node.alias || node.name);
        }
        case 'VariableDefinition': {
            return getName(node.variable);
        }
    }
    return undefined;
}
function convertFactory(config) {
    function resolveConventionName(type) {
        if (!config.namingConvention) {
            return (str, opts = {}) => {
                return convertNameParts(str, pascalCase, getConfigValue((opts || {}).transformUnderscore, false));
            };
        }
        if (typeof config.namingConvention === 'string') {
            if (config.namingConvention === 'keep') {
                return str => str;
            }
            return (str, opts = {}) => {
                return convertNameParts(str, resolveExternalModuleAndFn(config.namingConvention), getConfigValue((opts || {}).transformUnderscore, false));
            };
        }
        if (typeof config.namingConvention === 'function') {
            return (str, opts = {}) => {
                return convertNameParts(str, config.namingConvention, getConfigValue((opts || {}).transformUnderscore, false));
            };
        }
        if (typeof config.namingConvention === 'object' && config.namingConvention[type] === 'keep') {
            return str => str;
        }
        if (typeof config.namingConvention === 'object') {
            if (!config.namingConvention[type]) {
                return (str, opts = {}) => {
                    const transformUnderscore = config.namingConvention.transformUnderscore || (opts || {}).transformUnderscore;
                    return convertNameParts(str, pascalCase, getConfigValue(transformUnderscore, false));
                };
            }
            return (str, opts = {}) => {
                return convertNameParts(str, resolveExternalModuleAndFn(config.namingConvention[type]), getConfigValue((opts || {}).transformUnderscore, true));
            };
        }
        return config.namingConvention[type];
    }
    return (node, opts) => {
        const prefix = opts && opts.prefix;
        const suffix = opts && opts.suffix;
        const kind = getKind(node);
        const str = [prefix || '', getName(node), suffix || ''].join('');
        return resolveConventionName(kind)(str, opts);
    };
}

function escapeString(str) {
    return str.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/'/g, "\\'");
}
function parseEnumValues({ schema, mapOrStr = {}, ignoreEnumValuesFromSchema, }) {
    const allTypes = schema.getTypeMap();
    const allEnums = Object.keys(allTypes).filter(t => isEnumType(allTypes[t]));
    if (typeof mapOrStr === 'object') {
        if (!ignoreEnumValuesFromSchema) {
            for (const enumTypeName of allEnums) {
                const enumType = schema.getType(enumTypeName);
                for (const { name, value } of enumType.getValues()) {
                    if (value && value !== name) {
                        mapOrStr[enumTypeName] = mapOrStr[enumTypeName] || {};
                        if (typeof mapOrStr[enumTypeName] !== 'string' && !mapOrStr[enumTypeName][name]) {
                            mapOrStr[enumTypeName][name] = typeof value === 'string' ? escapeString(value) : value;
                        }
                    }
                }
            }
        }
        const invalidMappings = Object.keys(mapOrStr).filter(gqlName => !allEnums.includes(gqlName));
        if (invalidMappings.length > 0) {
            throw new DetailedError(`Invalid 'enumValues' mapping!`, `The following types does not exist in your GraphQL schema: ${invalidMappings.join(', ')}`);
        }
        return Object.keys(mapOrStr).reduce((prev, gqlIdentifier) => {
            const pointer = mapOrStr[gqlIdentifier];
            if (typeof pointer === 'string') {
                const mapper = parseMapper(pointer, gqlIdentifier);
                return {
                    ...prev,
                    [gqlIdentifier]: {
                        isDefault: mapper.isExternal && mapper.default,
                        typeIdentifier: gqlIdentifier,
                        sourceFile: mapper.isExternal ? mapper.source : null,
                        sourceIdentifier: mapper.type,
                        importIdentifier: mapper.isExternal ? mapper.import : null,
                        mappedValues: null,
                    },
                };
            }
            else if (typeof pointer === 'object') {
                return {
                    ...prev,
                    [gqlIdentifier]: {
                        isDefault: false,
                        typeIdentifier: gqlIdentifier,
                        sourceFile: null,
                        sourceIdentifier: null,
                        importIdentifier: null,
                        mappedValues: pointer,
                    },
                };
            }
            else {
                throw new DetailedError(`Invalid "enumValues" configuration`, `Enum "${gqlIdentifier}": expected string or object (with enum values mapping)`);
            }
        }, {});
    }
    else if (typeof mapOrStr === 'string') {
        return allEnums
            .filter(enumName => !enumName.startsWith('__'))
            .reduce((prev, enumName) => {
            return {
                ...prev,
                [enumName]: {
                    isDefault: false,
                    typeIdentifier: enumName,
                    sourceFile: mapOrStr,
                    sourceIdentifier: enumName,
                    importIdentifier: enumName,
                    mappedValues: null,
                },
            };
        }, {});
    }
    return {};
}

const DEFAULT_DECLARATION_KINDS = {
    scalar: 'type',
    input: 'type',
    type: 'type',
    interface: 'type',
    arguments: 'type',
};
function normalizeDeclarationKind(declarationKind) {
    if (typeof declarationKind === 'string') {
        return {
            scalar: declarationKind,
            input: declarationKind,
            type: declarationKind,
            interface: declarationKind,
            arguments: declarationKind,
        };
    }
    return {
        ...DEFAULT_DECLARATION_KINDS,
        ...declarationKind,
    };
}

const DEFAULT_AVOID_OPTIONALS = {
    object: false,
    inputValue: false,
    field: false,
    defaultValue: false,
};
function normalizeAvoidOptionals(avoidOptionals) {
    if (typeof avoidOptionals === 'boolean') {
        return {
            object: avoidOptionals,
            inputValue: avoidOptionals,
            field: avoidOptionals,
            defaultValue: avoidOptionals,
        };
    }
    return {
        ...DEFAULT_AVOID_OPTIONALS,
        ...avoidOptionals,
    };
}

function generateFragmentImportStatement(statement, kind) {
    const { importSource: fragmentImportSource, ...rest } = statement;
    const { identifiers, path, namespace } = fragmentImportSource;
    const importSource = {
        identifiers: identifiers
            .filter(fragmentImport => kind === 'both' || kind === fragmentImport.kind)
            .map(({ name }) => name),
        path,
        namespace,
    };
    return generateImportStatement({
        importSource,
        ...rest,
        typesImport: kind === 'type' ? statement.typesImport : false,
    });
}
function generateImportStatement(statement) {
    switch (extname(statement.importSource.path)) {
        default:
        case '.ts':
        case '.tsx':
            return generateImportStatementTypescript(statement);
        case '.py':
            return generateImportStatementPython(statement);
    }
}
function generateImportStatementTypescript(statement) {
    const { baseDir, importSource, outputPath, typesImport } = statement;
    const importPath = resolveImportPath(baseDir, outputPath, importSource.path);
    const importNames = importSource.identifiers && importSource.identifiers.length
        ? `{ ${Array.from(new Set(importSource.identifiers)).join(', ')} }`
        : '*';
    const importAlias = importSource.namespace ? ` as ${importSource.namespace}` : '';
    const importStatement = typesImport ? 'import type' : 'import';
    return `${importStatement} ${importNames}${importAlias} from '${importPath}';${importAlias ? '\n' : ''}`;
}
function generateImportStatementPython(statement) {
    const { baseDir, importSource, outputPath } = statement;
    const importPath = resolveImportPath(baseDir, outputPath, importSource.path).replace(/\.[^/.]+$/, "");
    const importNames = importSource.identifiers && importSource.identifiers.length
        ? ` ${Array.from(new Set(importSource.identifiers)).join(', ')}`
        : '';
    const importAlias = importSource.namespace ? ` as ${importSource.namespace}` : '';
    return `import ${importPath}${importNames}${importAlias}${importAlias ? '\n' : ''}`;
}
function resolveImportPath(baseDir, outputPath, sourcePath) {
    const shouldAbsolute = !sourcePath.startsWith('~');
    if (shouldAbsolute) {
        const absGeneratedFilePath = resolve(baseDir, outputPath);
        const absImportFilePath = resolve(baseDir, sourcePath);
        return resolveRelativeImport(absGeneratedFilePath, absImportFilePath);
    }
    else {
        return sourcePath.replace(`~`, '');
    }
}
function resolveRelativeImport(from, to) {
    if (!isAbsolute(from)) {
        throw new Error(`Argument 'from' must be an absolute path, '${from}' given.`);
    }
    if (!isAbsolute(to)) {
        throw new Error(`Argument 'to' must be an absolute path, '${to}' given.`);
    }
    return fixLocalFilePath(clearExtension(relative(dirname(from), to)));
}
function resolveImportSource(source) {
    return typeof source === 'string' ? { path: source } : source;
}
function clearExtension(path) {
    const parsedPath = parse(path);
    return join(parsedPath.dir, parsedPath.name).replace(/\\/g, '/');
}
function fixLocalFilePath(path) {
    return !path.startsWith('..') ? `./${path}` : path;
}

class BaseVisitor {
    constructor(rawConfig, additionalConfig) {
        this._declarationBlockConfig = {};
        this._parsedConfig = {
            convert: convertFactory(rawConfig),
            typesPrefix: rawConfig.typesPrefix || '',
            typesSuffix: rawConfig.typesSuffix || '',
            externalFragments: rawConfig.externalFragments || [],
            fragmentImports: rawConfig.fragmentImports || [],
            addTypename: !rawConfig.skipTypename,
            nonOptionalTypename: !!rawConfig.nonOptionalTypename,
            useTypeImports: !!rawConfig.useTypeImports,
            ...(additionalConfig || {}),
        };
        this.scalars = {};
        Object.keys(this.config.scalars || {}).forEach(key => {
            this.scalars[key] = this.config.scalars[key].type;
        });
        autoBind(this);
    }
    getVisitorKindContextFromAncestors(ancestors) {
        if (!ancestors) {
            return [];
        }
        return ancestors.map(t => t.kind).filter(Boolean);
    }
    get config() {
        return this._parsedConfig;
    }
    convertName(node, options) {
        const useTypesPrefix = typeof (options && options.useTypesPrefix) === 'boolean' ? options.useTypesPrefix : true;
        const useTypesSuffix = typeof (options && options.useTypesSuffix) === 'boolean' ? options.useTypesSuffix : true;
        let convertedName = '';
        if (useTypesPrefix) {
            convertedName += this.config.typesPrefix;
        }
        convertedName += this.config.convert(node, options);
        if (useTypesSuffix) {
            convertedName += this.config.typesSuffix;
        }
        return convertedName;
    }
    getOperationSuffix(node, operationType) {
        const { omitOperationSuffix = false, dedupeOperationSuffix = false } = this.config;
        const operationName = typeof node === 'string' ? node : node.name ? node.name.value : '';
        return omitOperationSuffix
            ? ''
            : dedupeOperationSuffix && operationName.toLowerCase().endsWith(operationType.toLowerCase())
                ? ''
                : operationType;
    }
    getFragmentSuffix(node) {
        return this.getOperationSuffix(node, 'Fragment');
    }
    getFragmentName(node) {
        return this.convertName(node, {
            suffix: this.getFragmentSuffix(node),
            useTypesPrefix: false,
        });
    }
    getFragmentVariableName(node) {
        const { omitOperationSuffix = false, dedupeOperationSuffix = false, fragmentVariableSuffix = 'FragmentDoc', fragmentVariablePrefix = '', } = this.config;
        const fragmentName = typeof node === 'string' ? node : node.name.value;
        const suffix = omitOperationSuffix
            ? ''
            : dedupeOperationSuffix &&
                fragmentName.toLowerCase().endsWith('fragment') &&
                fragmentVariableSuffix.toLowerCase().startsWith('fragment')
                ? fragmentVariableSuffix.substring('fragment'.length)
                : fragmentVariableSuffix;
        return this.convertName(node, {
            prefix: fragmentVariablePrefix,
            suffix,
            useTypesPrefix: false,
        });
    }
    getPunctuation(_declarationKind) {
        return '';
    }
}

class OperationVariablesToObject {
    constructor(_scalars, _convertName, _namespacedImportName = null, _enumNames = [], _enumPrefix = true, _enumValues = {}, _applyCoercion = false) {
        this._scalars = _scalars;
        this._convertName = _convertName;
        this._namespacedImportName = _namespacedImportName;
        this._enumNames = _enumNames;
        this._enumPrefix = _enumPrefix;
        this._enumValues = _enumValues;
        this._applyCoercion = _applyCoercion;
        autoBind(this);
    }
    getName(node) {
        if (node.name) {
            if (typeof node.name === 'string') {
                return node.name;
            }
            return node.name.value;
        }
        else if (node.variable) {
            return node.variable.name.value;
        }
        return null;
    }
    transform(variablesNode) {
        if (!variablesNode || variablesNode.length === 0) {
            return null;
        }
        return (variablesNode.map(variable => indent(this.transformVariable(variable))).join(`${this.getPunctuation()}\n`) +
            this.getPunctuation());
    }
    getScalar(name) {
        const prefix = this._namespacedImportName ? `${this._namespacedImportName}.` : '';
        return `${prefix}Scalars['${name}']`;
    }
    transformVariable(variable) {
        let typeValue = null;
        const prefix = this._namespacedImportName ? `${this._namespacedImportName}.` : '';
        if (typeof variable.type === 'string') {
            typeValue = variable.type;
        }
        else {
            const baseType = getBaseTypeNode(variable.type);
            const typeName = baseType.name.value;
            if (this._scalars[typeName]) {
                typeValue = this.getScalar(typeName);
            }
            else if (this._enumValues[typeName] && this._enumValues[typeName].sourceFile) {
                typeValue = this._enumValues[typeName].typeIdentifier || this._enumValues[typeName].sourceIdentifier;
            }
            else {
                typeValue = `${prefix}${this._convertName(baseType, {
                    useTypesPrefix: this._enumNames.includes(typeName) ? this._enumPrefix : true,
                })}`;
            }
        }
        const fieldName = this.getName(variable);
        const fieldType = this.wrapAstTypeWithModifiers(typeValue, variable.type, this._applyCoercion);
        const hasDefaultValue = variable.defaultValue != null && typeof variable.defaultValue !== 'undefined';
        const isNonNullType = variable.type.kind === Kind.NON_NULL_TYPE;
        const formattedFieldString = this.formatFieldString(fieldName, isNonNullType, hasDefaultValue);
        const formattedTypeString = this.formatTypeString(fieldType, isNonNullType, hasDefaultValue);
        return `${formattedFieldString}: ${formattedTypeString}`;
    }
    wrapAstTypeWithModifiers(_baseType, _typeNode, _applyCoercion) {
        throw new Error(`You must override "wrapAstTypeWithModifiers" of OperationVariablesToObject!`);
    }
    formatFieldString(fieldName, isNonNullType, _hasDefaultValue) {
        return fieldName;
    }
    formatTypeString(fieldType, isNonNullType, hasDefaultValue) {
        const prefix = this._namespacedImportName ? `${this._namespacedImportName}.` : '';
        if (hasDefaultValue) {
            return `${prefix}Maybe<${fieldType}>`;
        }
        return fieldType;
    }
    getPunctuation() {
        return ',';
    }
}

class BaseTypesVisitor extends BaseVisitor {
    constructor(_schema, rawConfig, additionalConfig, defaultScalars = DEFAULT_SCALARS) {
        super(rawConfig, {
            enumPrefix: getConfigValue(rawConfig.enumPrefix, true),
            onlyOperationTypes: getConfigValue(rawConfig.onlyOperationTypes, false),
            addUnderscoreToArgsType: getConfigValue(rawConfig.addUnderscoreToArgsType, false),
            enumValues: parseEnumValues({
                schema: _schema,
                mapOrStr: rawConfig.enumValues,
                ignoreEnumValuesFromSchema: rawConfig.ignoreEnumValuesFromSchema,
            }),
            declarationKind: normalizeDeclarationKind(rawConfig.declarationKind),
            scalars: buildScalarsFromConfig(_schema, rawConfig, defaultScalars),
            fieldWrapperValue: getConfigValue(rawConfig.fieldWrapperValue, 'T'),
            wrapFieldDefinitions: getConfigValue(rawConfig.wrapFieldDefinitions, false),
            entireFieldWrapperValue: getConfigValue(rawConfig.entireFieldWrapperValue, 'T'),
            wrapEntireDefinitions: getConfigValue(rawConfig.wrapEntireFieldDefinitions, false),
            ignoreEnumValuesFromSchema: getConfigValue(rawConfig.ignoreEnumValuesFromSchema, false),
            ...additionalConfig,
        });
        this._schema = _schema;
        this._argumentsTransformer = new OperationVariablesToObject(this.scalars, this.convertName);
    }
    getExportPrefix() {
        return 'export ';
    }
    getFieldWrapperValue() {
        if (this.config.fieldWrapperValue) {
            return `${this.getExportPrefix()}type FieldWrapper<T> = ${this.config.fieldWrapperValue};`;
        }
        return '';
    }
    getEntireFieldWrapperValue() {
        if (this.config.entireFieldWrapperValue) {
            return `${this.getExportPrefix()}type EntireFieldWrapper<T> = ${this.config.entireFieldWrapperValue};`;
        }
        return '';
    }
    getScalarsImports() {
        return Object.keys(this.config.scalars)
            .map(enumName => {
            const mappedValue = this.config.scalars[enumName];
            if (mappedValue.isExternal) {
                return this._buildTypeImport(mappedValue.import, mappedValue.source, mappedValue.default);
            }
            return null;
        })
            .filter(a => a);
    }
    get scalarsDefinition() {
        const allScalars = Object.keys(this.config.scalars).map(scalarName => {
            const scalarValue = this.config.scalars[scalarName].type;
            const scalarType = this._schema.getType(scalarName);
            const comment = scalarType && scalarType.astNode && scalarType.description ? transformComment(scalarType.description, 1) : '';
            const { scalar } = this._parsedConfig.declarationKind;
            return comment + indent(`${scalarName}: ${scalarValue}${this.getPunctuation(scalar)}`);
        });
        return new DeclarationBlock(this._declarationBlockConfig)
            .export()
            .asKind(this._parsedConfig.declarationKind.scalar)
            .withName('Scalars')
            .withComment('All built-in and custom scalars, mapped to their actual values')
            .withBlock(allScalars.join('\n')).string;
    }
    setDeclarationBlockConfig(config) {
        this._declarationBlockConfig = config;
    }
    setArgumentsTransformer(argumentsTransfomer) {
        this._argumentsTransformer = argumentsTransfomer;
    }
    NonNullType(node) {
        const asString = node.type;
        return asString;
    }
    getInputObjectDeclarationBlock(node) {
        return new DeclarationBlock(this._declarationBlockConfig)
            .export()
            .asKind(this._parsedConfig.declarationKind.input)
            .withName(this.convertName(node))
            .withComment(node.description)
            .withBlock(node.fields.join('\n'));
    }
    InputObjectTypeDefinition(node) {
        return this.getInputObjectDeclarationBlock(node).string;
    }
    InputValueDefinition(node) {
        const comment = transformComment(node.description, 1);
        const { input } = this._parsedConfig.declarationKind;
        return comment + indent(`${node.name}: ${node.type}${this.getPunctuation(input)}`);
    }
    Name(node) {
        return node.value;
    }
    FieldDefinition(node) {
        const typeString = node.type;
        const { type } = this._parsedConfig.declarationKind;
        const comment = this.getFieldComment(node);
        return comment + indent(`${node.name}: ${typeString}${this.getPunctuation(type)}`);
    }
    UnionTypeDefinition(node, key, parent) {
        if (this.config.onlyOperationTypes)
            return '';
        const originalNode = parent[key];
        const possibleTypes = originalNode.types
            .map(t => (this.scalars[t.name.value] ? this._getScalar(t.name.value) : this.convertName(t)))
            .join(' | ');
        return new DeclarationBlock(this._declarationBlockConfig)
            .export()
            .asKind('type')
            .withName(this.convertName(node))
            .withComment(node.description)
            .withContent(possibleTypes).string;
    }
    mergeInterfaces(interfaces, hasOtherFields) {
        return interfaces.join(' & ') + (interfaces.length && hasOtherFields ? ' & ' : '');
    }
    appendInterfacesAndFieldsToBlock(block, interfaces, fields) {
        block.withContent(this.mergeInterfaces(interfaces, fields.length > 0));
        block.withBlock(this.mergeAllFields(fields, interfaces.length > 0));
    }
    getObjectTypeDeclarationBlock(node, originalNode) {
        const optionalTypename = this.config.nonOptionalTypename ? '__typename' : '__typename?';
        const { type, interface: interfacesType } = this._parsedConfig.declarationKind;
        const allFields = [
            ...(this.config.addTypename
                ? [
                    indent(`${this.config.immutableTypes ? 'readonly ' : ''}${optionalTypename}: '${node.name}'${this.getPunctuation(type)}`),
                ]
                : []),
            ...node.fields,
        ];
        const interfacesNames = originalNode.interfaces ? originalNode.interfaces.map(i => this.convertName(i)) : [];
        const declarationBlock = new DeclarationBlock(this._declarationBlockConfig)
            .export()
            .asKind(type)
            .withName(this.convertName(node))
            .withComment(node.description);
        if (type === 'interface' || type === 'class') {
            if (interfacesNames.length > 0) {
                const keyword = interfacesType === 'interface' && type === 'class' ? 'implements' : 'extends';
                declarationBlock.withContent(`${keyword} ` + interfacesNames.join(', ') + (allFields.length > 0 ? ' ' : ' {}'));
            }
            declarationBlock.withBlock(this.mergeAllFields(allFields, false));
        }
        else {
            this.appendInterfacesAndFieldsToBlock(declarationBlock, interfacesNames, allFields);
        }
        return declarationBlock;
    }
    getFieldComment(node) {
        let commentText = node.description;
        const deprecationDirective = node.directives.find((v) => v.name === 'deprecated');
        if (deprecationDirective) {
            const deprecationReason = this.getDeprecationReason(deprecationDirective);
            commentText = `${commentText ? `${commentText}\n` : ''}@deprecated ${deprecationReason}`;
        }
        const comment = transformComment(commentText, 1);
        return comment;
    }
    mergeAllFields(allFields, _hasInterfaces) {
        return allFields.join('\n');
    }
    ObjectTypeDefinition(node, key, parent) {
        if (this.config.onlyOperationTypes)
            return '';
        const originalNode = parent[key];
        return [this.getObjectTypeDeclarationBlock(node, originalNode).string, this.buildArgumentsBlock(originalNode)]
            .filter(f => f)
            .join('\n\n');
    }
    getInterfaceTypeDeclarationBlock(node, _originalNode) {
        const declarationBlock = new DeclarationBlock(this._declarationBlockConfig)
            .export()
            .asKind(this._parsedConfig.declarationKind.interface)
            .withName(this.convertName(node))
            .withComment(node.description);
        return declarationBlock.withBlock(node.fields.join('\n'));
    }
    InterfaceTypeDefinition(node, key, parent) {
        if (this.config.onlyOperationTypes)
            return '';
        const originalNode = parent[key];
        return [this.getInterfaceTypeDeclarationBlock(node, originalNode).string, this.buildArgumentsBlock(originalNode)]
            .filter(f => f)
            .join('\n\n');
    }
    ScalarTypeDefinition(_node) {
        // We empty this because we handle scalars in a different way, see constructor.
        return '';
    }
    _buildTypeImport(identifier, source, asDefault = false) {
        const { useTypeImports } = this.config;
        if (asDefault) {
            if (useTypeImports) {
                return `import type { default as ${identifier} } from '${source}';`;
            }
            return `import ${identifier} from '${source}';`;
        }
        return `import${useTypeImports ? ' type' : ''} { ${identifier} } from '${source}';`;
    }
    handleEnumValueMapper(typeIdentifier, importIdentifier, sourceIdentifier, sourceFile) {
        const importStatement = this._buildTypeImport(importIdentifier || sourceIdentifier, sourceFile);
        if (importIdentifier !== sourceIdentifier || sourceIdentifier !== typeIdentifier) {
            return [importStatement, `import ${typeIdentifier} = ${sourceIdentifier};`];
        }
        return [importStatement];
    }
    getEnumsImports() {
        return flatMap(Object.keys(this.config.enumValues), enumName => {
            const mappedValue = this.config.enumValues[enumName];
            if (mappedValue.sourceFile) {
                if (mappedValue.isDefault) {
                    return [this._buildTypeImport(mappedValue.typeIdentifier, mappedValue.sourceFile, true)];
                }
                return this.handleEnumValueMapper(mappedValue.typeIdentifier, mappedValue.importIdentifier, mappedValue.sourceIdentifier, mappedValue.sourceFile);
            }
            return [];
        }).filter(a => a);
    }
    EnumTypeDefinition(node) {
        const enumName = node.name;
        // In case of mapped external enum string
        if (this.config.enumValues[enumName] && this.config.enumValues[enumName].sourceFile) {
            return null;
        }
        return new DeclarationBlock(this._declarationBlockConfig)
            .export()
            .asKind('enum')
            .withName(this.convertName(node, { useTypesPrefix: this.config.enumPrefix }))
            .withComment(node.description)
            .withBlock(this.buildEnumValuesBlock(enumName, node.values)).string;
    }
    // We are using it in order to transform "description" field
    StringValue(node) {
        return node.value;
    }
    makeValidEnumIdentifier(identifier) {
        if (/^[0-9]/.exec(identifier)) {
            return wrapWithSingleQuotes(identifier, true);
        }
        return identifier;
    }
    buildEnumValuesBlock(typeName, values) {
        const schemaEnumType = this._schema
            ? this._schema.getType(typeName)
            : undefined;
        return values
            .map(enumOption => {
            const optionName = this.makeValidEnumIdentifier(this.convertName(enumOption, { useTypesPrefix: false, transformUnderscore: true }));
            const comment = transformComment(enumOption.description, 1);
            const schemaEnumValue = schemaEnumType && !this.config.ignoreEnumValuesFromSchema
                ? schemaEnumType.getValue(enumOption.name).value
                : undefined;
            let enumValue = typeof schemaEnumValue !== 'undefined' ? schemaEnumValue : enumOption.name;
            if (this.config.enumValues[typeName] &&
                this.config.enumValues[typeName].mappedValues &&
                typeof this.config.enumValues[typeName].mappedValues[enumValue] !== 'undefined') {
                enumValue = this.config.enumValues[typeName].mappedValues[enumValue];
            }
            return (comment +
                indent(`${optionName}${this._declarationBlockConfig.enumNameValueSeparator} ${wrapWithSingleQuotes(enumValue, typeof schemaEnumValue !== 'undefined')}`));
        })
            .join(',\n');
    }
    DirectiveDefinition(_node) {
        return '';
    }
    getArgumentsObjectDeclarationBlock(node, name, field) {
        return new DeclarationBlock(this._declarationBlockConfig)
            .export()
            .asKind(this._parsedConfig.declarationKind.arguments)
            .withName(this.convertName(name))
            .withComment(node.description)
            .withBlock(this._argumentsTransformer.transform(field.arguments));
    }
    getArgumentsObjectTypeDefinition(node, name, field) {
        return this.getArgumentsObjectDeclarationBlock(node, name, field).string;
    }
    buildArgumentsBlock(node) {
        const fieldsWithArguments = node.fields.filter(field => field.arguments && field.arguments.length > 0) || [];
        return fieldsWithArguments
            .map(field => {
            const name = node.name.value +
                (this.config.addUnderscoreToArgsType ? '_' : '') +
                this.convertName(field, {
                    useTypesPrefix: false,
                    useTypesSuffix: false,
                }) +
                'Args';
            return this.getArgumentsObjectTypeDefinition(node, name, field);
        })
            .join('\n\n');
    }
    _getScalar(name) {
        return `Scalars['${name}']`;
    }
    _getTypeForNode(node) {
        const typeAsString = node.name;
        if (this.scalars[typeAsString]) {
            return this._getScalar(typeAsString);
        }
        else if (this.config.enumValues[typeAsString]) {
            return this.config.enumValues[typeAsString].typeIdentifier;
        }
        const schemaType = this._schema.getType(node.name);
        if (schemaType && isEnumType(schemaType)) {
            return this.convertName(node, { useTypesPrefix: this.config.enumPrefix });
        }
        return this.convertName(node);
    }
    NamedType(node, key, parent, path, ancestors) {
        const currentVisitContext = this.getVisitorKindContextFromAncestors(ancestors);
        const isVisitingInputType = currentVisitContext.includes(Kind.INPUT_OBJECT_TYPE_DEFINITION);
        const typeToUse = this._getTypeForNode(node);
        if (!isVisitingInputType && this.config.fieldWrapperValue && this.config.wrapFieldDefinitions) {
            return `FieldWrapper<${typeToUse}>`;
        }
        return typeToUse;
    }
    ListType(node) {
        const asString = node.type;
        return this.wrapWithListType(asString);
    }
    SchemaDefinition() {
        return null;
    }
    getDeprecationReason(directive) {
        if (directive.name === 'deprecated') {
            const hasArguments = directive.arguments.length > 0;
            let reason = 'Field no longer supported';
            if (hasArguments) {
                reason = directive.arguments[0].value;
            }
            return reason;
        }
    }
    wrapWithListType(str) {
        return `Array<${str}>`;
    }
}

function getRootType(operation, schema) {
    switch (operation) {
        case 'query':
            return schema.getQueryType();
        case 'mutation':
            return schema.getMutationType();
        case 'subscription':
            return schema.getSubscriptionType();
    }
}
class BaseDocumentsVisitor extends BaseVisitor {
    constructor(rawConfig, additionalConfig, _schema, defaultScalars = DEFAULT_SCALARS) {
        super(rawConfig, {
            exportFragmentSpreadSubTypes: getConfigValue(rawConfig.exportFragmentSpreadSubTypes, false),
            enumPrefix: getConfigValue(rawConfig.enumPrefix, true),
            preResolveTypes: getConfigValue(rawConfig.preResolveTypes, false),
            dedupeOperationSuffix: getConfigValue(rawConfig.dedupeOperationSuffix, false),
            omitOperationSuffix: getConfigValue(rawConfig.omitOperationSuffix, false),
            skipTypeNameForRoot: getConfigValue(rawConfig.skipTypeNameForRoot, false),
            namespacedImportName: getConfigValue(rawConfig.namespacedImportName, null),
            experimentalFragmentVariables: getConfigValue(rawConfig.experimentalFragmentVariables, false),
            addTypename: !rawConfig.skipTypename,
            globalNamespace: !!rawConfig.globalNamespace,
            operationResultSuffix: getConfigValue(rawConfig.operationResultSuffix, ''),
            scalars: buildScalarsFromConfig(_schema, rawConfig, defaultScalars),
            ...(additionalConfig || {}),
        });
        this._schema = _schema;
        this._unnamedCounter = 1;
        this._globalDeclarations = new Set();
        autoBind(this);
        this._variablesTransfomer = new OperationVariablesToObject(this.scalars, this.convertName, this.config.namespacedImportName);
    }
    getGlobalDeclarations(noExport = false) {
        return Array.from(this._globalDeclarations).map(t => (noExport ? t : `export ${t}`));
    }
    setSelectionSetHandler(handler) {
        this._selectionSetToObject = handler;
    }
    setDeclarationBlockConfig(config) {
        this._declarationBlockConfig = config;
    }
    setVariablesTransformer(variablesTransfomer) {
        this._variablesTransfomer = variablesTransfomer;
    }
    get schema() {
        return this._schema;
    }
    get addTypename() {
        return this._parsedConfig.addTypename;
    }
    handleAnonymousOperation(node) {
        const name = node.name && node.name.value;
        if (name) {
            return this.convertName(name, {
                useTypesPrefix: false,
                useTypesSuffix: false,
            });
        }
        return this.convertName(this._unnamedCounter++ + '', {
            prefix: 'Unnamed_',
            suffix: '_',
            useTypesPrefix: false,
            useTypesSuffix: false,
        });
    }
    FragmentDefinition(node) {
        const fragmentRootType = this._schema.getType(node.typeCondition.name.value);
        const selectionSet = this._selectionSetToObject.createNext(fragmentRootType, node.selectionSet);
        const fragmentSuffix = this.getFragmentSuffix(node);
        return [
            selectionSet.transformFragmentSelectionSetToTypes(node.name.value, fragmentSuffix, this._declarationBlockConfig),
            this.config.experimentalFragmentVariables
                ? new DeclarationBlock({
                    ...this._declarationBlockConfig,
                    blockTransformer: t => this.applyVariablesWrapper(t),
                })
                    .export()
                    .asKind('type')
                    .withName(this.convertName(node.name.value, {
                    suffix: fragmentSuffix + 'Variables',
                }))
                    .withBlock(this._variablesTransfomer.transform(node.variableDefinitions)).string
                : undefined,
        ]
            .filter(r => r)
            .join('\n\n');
    }
    applyVariablesWrapper(variablesBlock) {
        return variablesBlock;
    }
    OperationDefinition(node) {
        const name = this.handleAnonymousOperation(node);
        const operationRootType = getRootType(node.operation, this._schema);
        if (!operationRootType) {
            throw new Error(`Unable to find root schema type for operation type "${node.operation}"!`);
        }
        const selectionSet = this._selectionSetToObject.createNext(operationRootType, node.selectionSet);
        const visitedOperationVariables = this._variablesTransfomer.transform(node.variableDefinitions);
        const operationType = pascalCase(node.operation);
        const operationTypeSuffix = this.getOperationSuffix(name, operationType);
        const operationResult = new DeclarationBlock(this._declarationBlockConfig)
            .export()
            .asKind('type')
            .withName(this.convertName(name, {
            suffix: operationTypeSuffix + this._parsedConfig.operationResultSuffix,
        }))
            .withContent(selectionSet.transformSelectionSet()).string;
        const operationVariables = new DeclarationBlock({
            ...this._declarationBlockConfig,
            blockTransformer: t => this.applyVariablesWrapper(t),
        })
            .export()
            .asKind('type')
            .withName(this.convertName(name, {
            suffix: operationTypeSuffix + 'Variables',
        }))
            .withBlock(visitedOperationVariables).string;
        return [operationVariables, operationResult].filter(r => r).join('\n\n');
    }
}

class BaseResolversVisitor extends BaseVisitor {
    constructor(rawConfig, additionalConfig, _schema, defaultScalars = DEFAULT_SCALARS) {
        super(rawConfig, {
            immutableTypes: getConfigValue(rawConfig.immutableTypes, false),
            optionalResolveType: getConfigValue(rawConfig.optionalResolveType, false),
            enumPrefix: getConfigValue(rawConfig.enumPrefix, true),
            federation: getConfigValue(rawConfig.federation, false),
            resolverTypeWrapperSignature: getConfigValue(rawConfig.resolverTypeWrapperSignature, 'Promise<T> | T'),
            enumValues: parseEnumValues({
                schema: _schema,
                mapOrStr: rawConfig.enumValues,
            }),
            addUnderscoreToArgsType: getConfigValue(rawConfig.addUnderscoreToArgsType, false),
            onlyResolveTypeForInterfaces: getConfigValue(rawConfig.onlyResolveTypeForInterfaces, false),
            contextType: parseMapper(rawConfig.contextType || 'any', 'ContextType'),
            fieldContextTypes: getConfigValue(rawConfig.fieldContextTypes, []),
            resolverTypeSuffix: getConfigValue(rawConfig.resolverTypeSuffix, 'Resolvers'),
            allResolversTypeName: getConfigValue(rawConfig.allResolversTypeName, 'Resolvers'),
            rootValueType: parseMapper(rawConfig.rootValueType || '{}', 'RootValueType'),
            namespacedImportName: getConfigValue(rawConfig.namespacedImportName, ''),
            avoidOptionals: getConfigValue(rawConfig.avoidOptionals, false),
            defaultMapper: rawConfig.defaultMapper
                ? parseMapper(rawConfig.defaultMapper || 'any', 'DefaultMapperType')
                : null,
            mappers: transformMappers(rawConfig.mappers || {}, rawConfig.mapperTypeSuffix),
            scalars: buildScalarsFromConfig(_schema, rawConfig, defaultScalars),
            internalResolversPrefix: getConfigValue(rawConfig.internalResolversPrefix, '__'),
            ...(additionalConfig || {}),
        });
        this._schema = _schema;
        this._declarationBlockConfig = {};
        this._collectedResolvers = {};
        this._collectedDirectiveResolvers = {};
        this._usedMappers = {};
        this._resolversTypes = {};
        this._resolversParentTypes = {};
        this._rootTypeNames = [];
        this._globalDeclarations = new Set();
        this._hasScalars = false;
        this._hasFederation = false;
        autoBind(this);
        this._federation = new ApolloFederation({ enabled: this.config.federation, schema: this.schema });
        this._rootTypeNames = getRootTypeNames(_schema);
        this._variablesTransfomer = new OperationVariablesToObject(this.scalars, this.convertName, this.config.namespacedImportName);
        this._resolversTypes = this.createResolversFields(type => this.applyResolverTypeWrapper(type), type => this.clearResolverTypeWrapper(type), name => this.getTypeToUse(name));
        this._resolversParentTypes = this.createResolversFields(type => type, type => type, name => this.getParentTypeToUse(name), namedType => !isEnumType(namedType));
        this._fieldContextTypeMap = this.createFieldContextTypeMap();
    }
    getResolverTypeWrapperSignature() {
        return `export type ResolverTypeWrapper<T> = ${this.config.resolverTypeWrapperSignature};`;
    }
    shouldMapType(type, checkedBefore = {}, duringCheck = []) {
        if (checkedBefore[type.name] !== undefined) {
            return checkedBefore[type.name];
        }
        if (type.name.startsWith('__') || this.config.scalars[type.name]) {
            return false;
        }
        if (this.config.mappers[type.name]) {
            return true;
        }
        if (isObjectType(type) || isInterfaceType(type)) {
            const fields = type.getFields();
            return Object.keys(fields)
                .filter(fieldName => {
                const field = fields[fieldName];
                const fieldType = getBaseType(field.type);
                return !duringCheck.includes(fieldType.name);
            })
                .some(fieldName => {
                const field = fields[fieldName];
                const fieldType = getBaseType(field.type);
                if (checkedBefore[fieldType.name] !== undefined) {
                    return checkedBefore[fieldType.name];
                }
                if (this.config.mappers[type.name]) {
                    return true;
                }
                duringCheck.push(type.name);
                const innerResult = this.shouldMapType(fieldType, checkedBefore, duringCheck);
                return innerResult;
            });
        }
        return false;
    }
    convertName(node, options, applyNamespacedImport = false) {
        const sourceType = super.convertName(node, options);
        return `${applyNamespacedImport && this.config.namespacedImportName ? this.config.namespacedImportName + '.' : ''}${sourceType}`;
    }
    // Kamil: this one is heeeeavvyyyy
    createResolversFields(applyWrapper, clearWrapper, getTypeToUse, shouldInclude) {
        const allSchemaTypes = this._schema.getTypeMap();
        const nestedMapping = {};
        const typeNames = this._federation.filterTypeNames(Object.keys(allSchemaTypes));
        typeNames.forEach(typeName => {
            const schemaType = allSchemaTypes[typeName];
            nestedMapping[typeName] = this.shouldMapType(schemaType, nestedMapping);
        });
        return typeNames.reduce((prev, typeName) => {
            const schemaType = allSchemaTypes[typeName];
            if (typeName.startsWith('__') || (shouldInclude && !shouldInclude(schemaType))) {
                return prev;
            }
            let shouldApplyOmit = false;
            const isRootType = this._rootTypeNames.includes(typeName);
            const isMapped = this.config.mappers[typeName];
            const isScalar = this.config.scalars[typeName];
            const hasDefaultMapper = !!(this.config.defaultMapper && this.config.defaultMapper.type);
            if (isRootType) {
                prev[typeName] = applyWrapper(this.config.rootValueType.type);
                return prev;
            }
            else if (isMapped && this.config.mappers[typeName].type) {
                this.markMapperAsUsed(typeName);
                prev[typeName] = applyWrapper(this.config.mappers[typeName].type);
            }
            else if (isInterfaceType(schemaType)) {
                const allTypesMap = this._schema.getTypeMap();
                const implementingTypes = [];
                for (const graphqlType of Object.values(allTypesMap)) {
                    if (graphqlType instanceof GraphQLObjectType) {
                        const allInterfaces = graphqlType.getInterfaces();
                        if (allInterfaces.some(int => int.name === schemaType.name)) {
                            implementingTypes.push(graphqlType.name);
                        }
                    }
                }
                const possibleTypes = implementingTypes.map(name => getTypeToUse(name)).join(' | ') || 'never';
                prev[typeName] = possibleTypes;
                return prev;
            }
            else if (isEnumType(schemaType) && this.config.enumValues[typeName]) {
                prev[typeName] =
                    this.config.enumValues[typeName].sourceIdentifier ||
                        this.convertName(this.config.enumValues[typeName].typeIdentifier);
            }
            else if (hasDefaultMapper && !hasPlaceholder(this.config.defaultMapper.type)) {
                prev[typeName] = applyWrapper(this.config.defaultMapper.type);
            }
            else if (isScalar) {
                prev[typeName] = applyWrapper(this._getScalar(typeName));
            }
            else if (isUnionType(schemaType)) {
                prev[typeName] = schemaType
                    .getTypes()
                    .map(type => getTypeToUse(type.name))
                    .join(' | ');
            }
            else {
                shouldApplyOmit = true;
                prev[typeName] = this.convertName(typeName, { useTypesPrefix: this.config.enumPrefix }, true);
            }
            if (shouldApplyOmit && prev[typeName] !== 'any' && isObjectType(schemaType)) {
                const fields = schemaType.getFields();
                const relevantFields = this._federation
                    .filterFieldNames(Object.keys(fields))
                    .map(fieldName => {
                    const field = fields[fieldName];
                    const baseType = getBaseType(field.type);
                    const isUnion = isUnionType(baseType);
                    if (!this.config.mappers[baseType.name] && !isUnion && !nestedMapping[baseType.name]) {
                        return null;
                    }
                    const addOptionalSign = !this.config.avoidOptionals && !isNonNullType(field.type);
                    return {
                        addOptionalSign,
                        fieldName,
                        replaceWithType: wrapTypeWithModifiers(getTypeToUse(baseType.name), field.type, {
                            wrapOptional: this.applyMaybe,
                            wrapArray: this.wrapWithArray,
                        }),
                    };
                })
                    .filter(a => a);
                if (relevantFields.length > 0) {
                    // Puts ResolverTypeWrapper on top of an entire type
                    prev[typeName] = applyWrapper(this.replaceFieldsInType(prev[typeName], relevantFields));
                }
                else {
                    // We still want to use ResolverTypeWrapper, even if we don't touch any fields
                    prev[typeName] = applyWrapper(prev[typeName]);
                }
            }
            if (isMapped && hasPlaceholder(prev[typeName])) {
                prev[typeName] = replacePlaceholder(prev[typeName], typeName);
            }
            if (!isMapped && hasDefaultMapper && hasPlaceholder(this.config.defaultMapper.type)) {
                // Make sure the inner type has no ResolverTypeWrapper
                const name = clearWrapper(isScalar ? this._getScalar(typeName) : prev[typeName]);
                const replaced = replacePlaceholder(this.config.defaultMapper.type, name);
                // Don't wrap Union with ResolverTypeWrapper, each inner type already has it
                if (isUnionType(schemaType)) {
                    prev[typeName] = replaced;
                }
                else {
                    prev[typeName] = applyWrapper(replacePlaceholder(this.config.defaultMapper.type, name));
                }
            }
            return prev;
        }, {});
    }
    replaceFieldsInType(typeName, relevantFields) {
        this._globalDeclarations.add(OMIT_TYPE);
        return `Omit<${typeName}, ${relevantFields.map(f => `'${f.fieldName}'`).join(' | ')}> & { ${relevantFields
            .map(f => `${f.fieldName}${f.addOptionalSign ? '?' : ''}: ${f.replaceWithType}`)
            .join(', ')} }`;
    }
    applyMaybe(str) {
        const namespacedImportPrefix = this.config.namespacedImportName ? this.config.namespacedImportName + '.' : '';
        return `${namespacedImportPrefix}Maybe<${str}>`;
    }
    applyResolverTypeWrapper(str) {
        return `ResolverTypeWrapper<${this.clearResolverTypeWrapper(str)}>`;
    }
    clearMaybe(str) {
        const namespacedImportPrefix = this.config.namespacedImportName ? this.config.namespacedImportName + '.' : '';
        if (str.startsWith(`${namespacedImportPrefix}Maybe<`)) {
            const maybeRe = new RegExp(`${namespacedImportPrefix.replace('.', '\\.')}Maybe<(.*?)>$`);
            return str.replace(maybeRe, '$1');
        }
        return str;
    }
    clearResolverTypeWrapper(str) {
        if (str.startsWith('ResolverTypeWrapper<')) {
            return str.replace(/ResolverTypeWrapper<(.*?)>$/, '$1');
        }
        return str;
    }
    wrapWithArray(t) {
        if (this.config.immutableTypes) {
            return `ReadonlyArray<${t}>`;
        }
        return `Array<${t}>`;
    }
    createFieldContextTypeMap() {
        return this.config.fieldContextTypes.reduce((prev, fieldContextType) => {
            const items = fieldContextType.split('#');
            if (items.length === 3) {
                const [path, source, contextTypeName] = items;
                return { ...prev, [path]: parseMapper(`${source}#${contextTypeName}`) };
            }
            const [path, contextType] = items;
            return { ...prev, [path]: parseMapper(contextType) };
        }, {});
    }
    buildResolversTypes() {
        const declarationKind = 'type';
        return new DeclarationBlock(this._declarationBlockConfig)
            .export()
            .asKind(declarationKind)
            .withName(this.convertName('ResolversTypes'))
            .withComment('Mapping between all available schema types and the resolvers types')
            .withBlock(Object.keys(this._resolversTypes)
            .map(typeName => indent(`${typeName}: ${this._resolversTypes[typeName]}${this.getPunctuation(declarationKind)}`))
            .join('\n')).string;
    }
    buildResolversParentTypes() {
        const declarationKind = 'type';
        return new DeclarationBlock(this._declarationBlockConfig)
            .export()
            .asKind(declarationKind)
            .withName(this.convertName('ResolversParentTypes'))
            .withComment('Mapping between all available schema types and the resolvers parents')
            .withBlock(Object.keys(this._resolversParentTypes)
            .map(typeName => indent(`${typeName}: ${this._resolversParentTypes[typeName]}${this.getPunctuation(declarationKind)}`))
            .join('\n')).string;
    }
    get schema() {
        return this._schema;
    }
    get defaultMapperType() {
        return this.config.defaultMapper.type;
    }
    get unusedMappers() {
        return Object.keys(this.config.mappers).filter(name => !this._usedMappers[name]);
    }
    get globalDeclarations() {
        return Array.from(this._globalDeclarations);
    }
    isMapperImported(groupedMappers, identifier, source) {
        const exists = !groupedMappers[source] ? false : !!groupedMappers[source].find(m => m.identifier === identifier);
        const existsFromEnums = !!Object.keys(this.config.enumValues)
            .map(key => this.config.enumValues[key])
            .find(o => o.sourceFile === source && o.typeIdentifier === identifier);
        return exists || existsFromEnums;
    }
    get mappersImports() {
        const groupedMappers = {};
        const addMapper = (source, identifier, asDefault) => {
            if (!this.isMapperImported(groupedMappers, identifier, source)) {
                if (!groupedMappers[source]) {
                    groupedMappers[source] = [];
                }
                groupedMappers[source].push({ identifier, asDefault });
            }
        };
        Object.keys(this.config.mappers)
            .map(gqlTypeName => ({ gqlType: gqlTypeName, mapper: this.config.mappers[gqlTypeName] }))
            .filter(({ mapper }) => mapper.isExternal)
            .forEach(({ mapper }) => {
            const externalMapper = mapper;
            const identifier = stripMapperTypeInterpolation(externalMapper.import);
            addMapper(externalMapper.source, identifier, externalMapper.default);
        });
        if (this.config.contextType.isExternal) {
            addMapper(this.config.contextType.source, this.config.contextType.import, this.config.contextType.default);
        }
        if (this.config.rootValueType.isExternal) {
            addMapper(this.config.rootValueType.source, this.config.rootValueType.import, this.config.rootValueType.default);
        }
        if (this.config.defaultMapper && this.config.defaultMapper.isExternal) {
            const identifier = stripMapperTypeInterpolation(this.config.defaultMapper.import);
            addMapper(this.config.defaultMapper.source, identifier, this.config.defaultMapper.default);
        }
        Object.values(this._fieldContextTypeMap).forEach(parsedMapper => {
            if (parsedMapper.isExternal) {
                addMapper(parsedMapper.source, parsedMapper.import, parsedMapper.default);
            }
        });
        return Object.keys(groupedMappers)
            .map(source => buildMapperImport(source, groupedMappers[source], this.config.useTypeImports))
            .filter(Boolean);
    }
    setDeclarationBlockConfig(config) {
        this._declarationBlockConfig = config;
    }
    setVariablesTransformer(variablesTransfomer) {
        this._variablesTransfomer = variablesTransfomer;
    }
    hasScalars() {
        return this._hasScalars;
    }
    hasFederation() {
        return this._hasFederation;
    }
    getRootResolver() {
        const name = this.convertName(this.config.allResolversTypeName);
        const declarationKind = 'type';
        const contextType = `<ContextType = ${this.config.contextType.type}>`;
        // This is here because we don't want to break IResolvers, so there is a mapping by default,
        // and if the developer is overriding typesPrefix, it won't get generated at all.
        const deprecatedIResolvers = !this.config.typesPrefix
            ? `
/**
 * @deprecated
 * Use "Resolvers" root object instead. If you wish to get "IResolvers", add "typesPrefix: I" to your config.
 */
export type IResolvers${contextType} = ${name}<ContextType>;`
            : '';
        return [
            new DeclarationBlock(this._declarationBlockConfig)
                .export()
                .asKind(declarationKind)
                .withName(name, contextType)
                .withBlock(Object.keys(this._collectedResolvers)
                .map(schemaTypeName => {
                const resolverType = this._collectedResolvers[schemaTypeName];
                return indent(this.formatRootResolver(schemaTypeName, resolverType, declarationKind));
            })
                .join('\n')).string,
            deprecatedIResolvers,
        ].join('\n');
    }
    formatRootResolver(schemaTypeName, resolverType, declarationKind) {
        return `${schemaTypeName}${this.config.avoidOptionals ? '' : '?'}: ${resolverType}${this.getPunctuation(declarationKind)}`;
    }
    getAllDirectiveResolvers() {
        if (Object.keys(this._collectedDirectiveResolvers).length) {
            const declarationKind = 'type';
            const name = this.convertName('DirectiveResolvers');
            const contextType = `<ContextType = ${this.config.contextType.type}>`;
            // This is here because we don't want to break IResolvers, so there is a mapping by default,
            // and if the developer is overriding typesPrefix, it won't get generated at all.
            const deprecatedIResolvers = !this.config.typesPrefix
                ? `
/**
 * @deprecated
 * Use "DirectiveResolvers" root object instead. If you wish to get "IDirectiveResolvers", add "typesPrefix: I" to your config.
 */
export type IDirectiveResolvers${contextType} = ${name}<ContextType>;`
                : '';
            return [
                new DeclarationBlock(this._declarationBlockConfig)
                    .export()
                    .asKind(declarationKind)
                    .withName(name, contextType)
                    .withBlock(Object.keys(this._collectedDirectiveResolvers)
                    .map(schemaTypeName => {
                    const resolverType = this._collectedDirectiveResolvers[schemaTypeName];
                    return indent(this.formatRootResolver(schemaTypeName, resolverType, declarationKind));
                })
                    .join('\n')).string,
                deprecatedIResolvers,
            ].join('\n');
        }
        return '';
    }
    Name(node) {
        return node.value;
    }
    ListType(node) {
        const asString = node.type;
        return this.wrapWithArray(asString);
    }
    _getScalar(name) {
        return `${this.config.namespacedImportName ? this.config.namespacedImportName + '.' : ''}Scalars['${name}']`;
    }
    NamedType(node) {
        const nameStr = node.name;
        if (this.config.scalars[nameStr]) {
            return this._getScalar(nameStr);
        }
        return this.convertName(node, null, true);
    }
    NonNullType(node) {
        const asString = node.type;
        return asString;
    }
    markMapperAsUsed(name) {
        this._usedMappers[name] = true;
    }
    getTypeToUse(name) {
        const resolversType = this.convertName('ResolversTypes');
        return `${resolversType}['${name}']`;
    }
    getParentTypeToUse(name) {
        const resolversType = this.convertName('ResolversParentTypes');
        return `${resolversType}['${name}']`;
    }
    getParentTypeForSignature(_node) {
        return 'ParentType';
    }
    transformParentGenericType(parentType) {
        return `ParentType extends ${parentType} = ${parentType}`;
    }
    FieldDefinition(node, key, parent) {
        const hasArguments = node.arguments && node.arguments.length > 0;
        const declarationKind = 'type';
        return (parentName) => {
            const original = parent[key];
            const baseType = getBaseTypeNode(original.type);
            const realType = baseType.name.value;
            const parentType = this.schema.getType(parentName);
            if (this._federation.skipField({ fieldNode: original, parentType: parentType })) {
                return null;
            }
            const typeToUse = this.getTypeToUse(realType);
            const mappedType = this._variablesTransfomer.wrapAstTypeWithModifiers(typeToUse, original.type);
            const subscriptionType = this._schema.getSubscriptionType();
            const isSubscriptionType = subscriptionType && subscriptionType.name === parentName;
            let argsType = hasArguments
                ? this.convertName(parentName +
                    (this.config.addUnderscoreToArgsType ? '_' : '') +
                    this.convertName(node.name, {
                        useTypesPrefix: false,
                        useTypesSuffix: false,
                    }) +
                    'Args', {
                    useTypesPrefix: true,
                }, true)
                : null;
            if (argsType !== null) {
                const argsToForceRequire = original.arguments.filter(arg => !!arg.defaultValue || arg.type.kind === 'NonNullType');
                if (argsToForceRequire.length > 0) {
                    argsType = this.applyRequireFields(argsType, argsToForceRequire);
                }
                else if (original.arguments.length > 0) {
                    argsType = this.applyOptionalFields(argsType, original.arguments);
                }
            }
            const parentTypeSignature = this._federation.transformParentType({
                fieldNode: original,
                parentType,
                parentTypeSignature: this.getParentTypeForSignature(node),
            });
            const mappedTypeKey = isSubscriptionType ? `${mappedType}, "${node.name}"` : mappedType;
            const signature = {
                name: node.name,
                modifier: this.config.avoidOptionals ? '' : '?',
                type: isSubscriptionType ? 'SubscriptionResolver' : 'Resolver',
                genericTypes: [
                    mappedTypeKey,
                    parentTypeSignature,
                    this._fieldContextTypeMap[`${parentName}.${node.name}`]
                        ? this._fieldContextTypeMap[`${parentName}.${node.name}`].type
                        : 'ContextType',
                    argsType,
                ].filter(f => f),
            };
            if (this._federation.isResolveReferenceField(node)) {
                this._hasFederation = true;
                signature.type = 'ReferenceResolver';
                if (signature.genericTypes.length >= 3) {
                    signature.genericTypes = signature.genericTypes.slice(0, 3);
                }
            }
            return indent(`${signature.name}${signature.modifier}: ${signature.type}<${signature.genericTypes.join(', ')}>${this.getPunctuation(declarationKind)}`);
        };
    }
    applyRequireFields(argsType, fields) {
        this._globalDeclarations.add(REQUIRE_FIELDS_TYPE);
        return `RequireFields<${argsType}, ${fields.map(f => `'${f.name.value}'`).join(' | ')}>`;
    }
    applyOptionalFields(argsType, _fields) {
        this._globalDeclarations.add(REQUIRE_FIELDS_TYPE);
        return `RequireFields<${argsType}, never>`;
    }
    ObjectTypeDefinition(node) {
        var _a, _b, _c;
        const declarationKind = 'type';
        const name = this.convertName(node, {
            suffix: this.config.resolverTypeSuffix,
        });
        const typeName = node.name;
        const parentType = this.getParentTypeToUse(typeName);
        const isRootType = [
            (_a = this.schema.getQueryType()) === null || _a === void 0 ? void 0 : _a.name,
            (_b = this.schema.getMutationType()) === null || _b === void 0 ? void 0 : _b.name,
            (_c = this.schema.getSubscriptionType()) === null || _c === void 0 ? void 0 : _c.name,
        ].includes(typeName);
        const fieldsContent = node.fields.map((f) => f(node.name));
        if (!isRootType) {
            fieldsContent.push(indent(`${this.config.internalResolversPrefix}isTypeOf?: IsTypeOfResolverFn<ParentType, ContextType>${this.getPunctuation(declarationKind)}`));
        }
        const block = new DeclarationBlock(this._declarationBlockConfig)
            .export()
            .asKind(declarationKind)
            .withName(name, `<ContextType = ${this.config.contextType.type}, ${this.transformParentGenericType(parentType)}>`)
            .withBlock(fieldsContent.join('\n'));
        this._collectedResolvers[node.name] = name + '<ContextType>';
        return block.string;
    }
    UnionTypeDefinition(node, key, parent) {
        const declarationKind = 'type';
        const name = this.convertName(node, {
            suffix: this.config.resolverTypeSuffix,
        });
        const originalNode = parent[key];
        const possibleTypes = originalNode.types
            .map(node => node.name.value)
            .map(f => `'${f}'`)
            .join(' | ');
        this._collectedResolvers[node.name] = name + '<ContextType>';
        const parentType = this.getParentTypeToUse(node.name);
        return new DeclarationBlock(this._declarationBlockConfig)
            .export()
            .asKind(declarationKind)
            .withName(name, `<ContextType = ${this.config.contextType.type}, ${this.transformParentGenericType(parentType)}>`)
            .withBlock(indent(`${this.config.internalResolversPrefix}resolveType${this.config.optionalResolveType ? '?' : ''}: TypeResolveFn<${possibleTypes}, ParentType, ContextType>${this.getPunctuation(declarationKind)}`)).string;
    }
    ScalarTypeDefinition(node) {
        const nameAsString = node.name;
        const baseName = this.getTypeToUse(nameAsString);
        if (this._federation.skipScalar(nameAsString)) {
            return null;
        }
        this._hasScalars = true;
        this._collectedResolvers[node.name] = 'GraphQLScalarType';
        return new DeclarationBlock({
            ...this._declarationBlockConfig,
            blockTransformer(block) {
                return block;
            },
        })
            .export()
            .asKind('interface')
            .withName(this.convertName(node, {
            suffix: 'ScalarConfig',
        }), ` extends GraphQLScalarTypeConfig<${baseName}, any>`)
            .withBlock(indent(`name: '${node.name}'${this.getPunctuation('interface')}`)).string;
    }
    DirectiveDefinition(node, key, parent) {
        if (this._federation.skipDirective(node.name)) {
            return null;
        }
        const directiveName = this.convertName(node, {
            suffix: 'DirectiveResolver',
        });
        const sourceNode = parent[key];
        const hasArguments = sourceNode.arguments && sourceNode.arguments.length > 0;
        this._collectedDirectiveResolvers[node.name] = directiveName + '<any, any, ContextType>';
        const directiveArgsTypeName = this.convertName(node, {
            suffix: 'DirectiveArgs',
        });
        return [
            new DeclarationBlock({
                ...this._declarationBlockConfig,
                blockTransformer(block) {
                    return block;
                },
            })
                .export()
                .asKind('type')
                .withName(directiveArgsTypeName)
                .withContent(`{ ${hasArguments ? this._variablesTransfomer.transform(sourceNode.arguments) : ''} }`).string,
            new DeclarationBlock({
                ...this._declarationBlockConfig,
                blockTransformer(block) {
                    return block;
                },
            })
                .export()
                .asKind('type')
                .withName(directiveName, `<Result, Parent, ContextType = ${this.config.contextType.type}, Args = ${directiveArgsTypeName}>`)
                .withContent(`DirectiveResolverFn<Result, Parent, ContextType, Args>`).string,
        ].join('\n');
    }
    buildEnumResolverContentBlock(_node, _mappedEnumType) {
        throw new Error(`buildEnumResolverContentBlock is not implemented!`);
    }
    buildEnumResolversExplicitMappedValues(_node, _valuesMapping) {
        throw new Error(`buildEnumResolversExplicitMappedValues is not implemented!`);
    }
    EnumTypeDefinition(node) {
        const rawTypeName = node.name;
        // If we have enumValues set, and it's point to an external enum - we need to allow internal values resolvers
        // In case we have enumValues set but as explicit values, no need to to do mapping since it's already
        // have type validation (the original enum has been modified by base types plugin).
        // If we have mapper for that type - we can skip
        if (!this.config.mappers[rawTypeName] && !this.config.enumValues[rawTypeName]) {
            return null;
        }
        const name = this.convertName(node, { suffix: this.config.resolverTypeSuffix });
        this._collectedResolvers[rawTypeName] = name;
        const hasExplicitValues = this.config.enumValues[rawTypeName] && this.config.enumValues[rawTypeName].mappedValues;
        return new DeclarationBlock(this._declarationBlockConfig)
            .export()
            .asKind('type')
            .withName(name)
            .withContent(hasExplicitValues
            ? this.buildEnumResolversExplicitMappedValues(node, this.config.enumValues[rawTypeName].mappedValues)
            : this.buildEnumResolverContentBlock(node, this.getTypeToUse(rawTypeName))).string;
    }
    InterfaceTypeDefinition(node) {
        const name = this.convertName(node, {
            suffix: this.config.resolverTypeSuffix,
        });
        const declarationKind = 'type';
        const allTypesMap = this._schema.getTypeMap();
        const implementingTypes = [];
        this._collectedResolvers[node.name] = name + '<ContextType>';
        for (const graphqlType of Object.values(allTypesMap)) {
            if (graphqlType instanceof GraphQLObjectType) {
                const allInterfaces = graphqlType.getInterfaces();
                if (allInterfaces.find(int => int.name === node.name)) {
                    implementingTypes.push(graphqlType.name);
                }
            }
        }
        const parentType = this.getParentTypeToUse(node.name);
        const possibleTypes = implementingTypes.map(name => `'${name}'`).join(' | ') || 'null';
        const fields = this.config.onlyResolveTypeForInterfaces ? [] : node.fields || [];
        return new DeclarationBlock(this._declarationBlockConfig)
            .export()
            .asKind(declarationKind)
            .withName(name, `<ContextType = ${this.config.contextType.type}, ${this.transformParentGenericType(parentType)}>`)
            .withBlock([
            indent(`${this.config.internalResolversPrefix}resolveType${this.config.optionalResolveType ? '?' : ''}: TypeResolveFn<${possibleTypes}, ParentType, ContextType>${this.getPunctuation(declarationKind)}`),
            ...fields.map((f) => f(node.name)),
        ].join('\n')).string;
    }
    SchemaDefinition() {
        return null;
    }
}
function replacePlaceholder(pattern, typename) {
    return pattern.replace('{T}', typename);
}
function hasPlaceholder(pattern) {
    return pattern.includes('{T}');
}

gqlTag.enableExperimentalFragmentVariables();
var DocumentMode;
(function (DocumentMode) {
    DocumentMode["graphQLTag"] = "graphQLTag";
    DocumentMode["documentNode"] = "documentNode";
    DocumentMode["documentNodeImportFragments"] = "documentNodeImportFragments";
    DocumentMode["external"] = "external";
    DocumentMode["string"] = "string";
})(DocumentMode || (DocumentMode = {}));
const EXTENSIONS_TO_REMOVE = ['.ts', '.tsx', '.js', '.jsx'];
class ClientSideBaseVisitor extends BaseVisitor {
    constructor(_schema, _fragments, rawConfig, additionalConfig, documents) {
        super(rawConfig, {
            scalars: buildScalarsFromConfig(_schema, rawConfig),
            dedupeOperationSuffix: getConfigValue(rawConfig.dedupeOperationSuffix, false),
            optimizeDocumentNode: getConfigValue(rawConfig.optimizeDocumentNode, true),
            omitOperationSuffix: getConfigValue(rawConfig.omitOperationSuffix, false),
            gqlImport: rawConfig.gqlImport || null,
            documentNodeImport: rawConfig.documentNodeImport || null,
            noExport: !!rawConfig.noExport,
            importOperationTypesFrom: getConfigValue(rawConfig.importOperationTypesFrom, null),
            operationResultSuffix: getConfigValue(rawConfig.operationResultSuffix, ''),
            documentVariablePrefix: getConfigValue(rawConfig.documentVariablePrefix, ''),
            documentVariableSuffix: getConfigValue(rawConfig.documentVariableSuffix, 'Document'),
            fragmentVariablePrefix: getConfigValue(rawConfig.fragmentVariablePrefix, ''),
            fragmentVariableSuffix: getConfigValue(rawConfig.fragmentVariableSuffix, 'FragmentDoc'),
            documentMode: ((rawConfig) => {
                if (typeof rawConfig.noGraphQLTag === 'boolean') {
                    return rawConfig.noGraphQLTag ? DocumentMode.documentNode : DocumentMode.graphQLTag;
                }
                return getConfigValue(rawConfig.documentMode, DocumentMode.graphQLTag);
            })(rawConfig),
            importDocumentNodeExternallyFrom: getConfigValue(rawConfig.importDocumentNodeExternallyFrom, ''),
            pureMagicComment: getConfigValue(rawConfig.pureMagicComment, false),
            experimentalFragmentVariables: getConfigValue(rawConfig.experimentalFragmentVariables, false),
            ...additionalConfig,
        });
        this._schema = _schema;
        this._fragments = _fragments;
        this._collectedOperations = [];
        this._documents = [];
        this._additionalImports = [];
        this._imports = new Set();
        this._documents = documents;
        autoBind(this);
    }
    _extractFragments(document, withNested = false) {
        if (!document) {
            return [];
        }
        const names = new Set();
        visit(document, {
            enter: {
                FragmentSpread: (node) => {
                    names.add(node.name.value);
                    if (withNested) {
                        const foundFragment = this._fragments.find(f => f.name === node.name.value);
                        if (foundFragment) {
                            const childItems = this._extractFragments(foundFragment.node, true);
                            if (childItems && childItems.length > 0) {
                                for (const item of childItems) {
                                    names.add(item);
                                }
                            }
                        }
                    }
                },
            },
        });
        return Array.from(names);
    }
    _transformFragments(document) {
        const includeNestedFragments = this.config.documentMode === DocumentMode.documentNode;
        return this._extractFragments(document, includeNestedFragments).map(document => this.getFragmentVariableName(document));
    }
    _includeFragments(fragments) {
        if (fragments && fragments.length > 0) {
            if (this.config.documentMode === DocumentMode.documentNode) {
                return this._fragments
                    .filter(f => fragments.includes(this.getFragmentVariableName(f.name)))
                    .map(fragment => print(fragment.node))
                    .join('\n');
            }
            else if (this.config.documentMode === DocumentMode.documentNodeImportFragments) {
                return '';
            }
            else {
                return `${fragments.map(name => '${' + name + '}').join('\n')}`;
            }
        }
        return '';
    }
    _prepareDocument(documentStr) {
        return documentStr;
    }
    _gql(node) {
        const fragments = this._transformFragments(node);
        const doc = this._prepareDocument(`
    ${print(node).split('\\').join('\\\\') /* Re-escape escaped values in GraphQL syntax */}
    ${this._includeFragments(fragments)}`);
        if (this.config.documentMode === DocumentMode.documentNode) {
            let gqlObj = gqlTag([doc]);
            if (this.config.optimizeDocumentNode) {
                gqlObj = optimizeDocumentNode(gqlObj);
            }
            return JSON.stringify(gqlObj);
        }
        else if (this.config.documentMode === DocumentMode.documentNodeImportFragments) {
            let gqlObj = gqlTag([doc]);
            if (this.config.optimizeDocumentNode) {
                gqlObj = optimizeDocumentNode(gqlObj);
            }
            if (fragments.length > 0) {
                const definitions = [
                    ...gqlObj.definitions.map(t => JSON.stringify(t)),
                    ...fragments.map(name => `...${name}.definitions`),
                ].join();
                return `{"kind":"${Kind.DOCUMENT}","definitions":[${definitions}]}`;
            }
            return JSON.stringify(gqlObj);
        }
        else if (this.config.documentMode === DocumentMode.string) {
            return '`' + doc + '`';
        }
        const gqlImport = this._parseImport(this.config.gqlImport || 'graphql-tag');
        return (gqlImport.propName || 'gql') + '`' + doc + '`';
    }
    _generateFragment(fragmentDocument) {
        const name = this.getFragmentVariableName(fragmentDocument);
        const fragmentTypeSuffix = this.getFragmentSuffix(fragmentDocument);
        return `export const ${name}${this.getDocumentNodeSignature(this.convertName(fragmentDocument.name.value, {
            useTypesPrefix: true,
            suffix: fragmentTypeSuffix,
        }), this.config.experimentalFragmentVariables
            ? this.convertName(fragmentDocument.name.value, {
                suffix: fragmentTypeSuffix + 'Variables',
            })
            : 'unknown', fragmentDocument)} =${this.config.pureMagicComment ? ' /*#__PURE__*/' : ''} ${this._gql(fragmentDocument)};`;
    }
    get fragmentsGraph() {
        const graph = new DepGraph({ circular: true });
        for (const fragment of this._fragments) {
            if (graph.hasNode(fragment.name)) {
                const cachedAsString = print(graph.getNodeData(fragment.name).node);
                const asString = print(fragment.node);
                if (cachedAsString !== asString) {
                    throw new Error(`Duplicated fragment called '${fragment.name}'!`);
                }
            }
            graph.addNode(fragment.name, fragment);
        }
        this._fragments.forEach(fragment => {
            const depends = this._extractFragments(fragment.node);
            if (depends && depends.length > 0) {
                depends.forEach(name => {
                    graph.addDependency(fragment.name, name);
                });
            }
        });
        return graph;
    }
    get fragments() {
        if (this._fragments.length === 0 || this.config.documentMode === DocumentMode.external) {
            return '';
        }
        const graph = this.fragmentsGraph;
        const orderedDeps = graph.overallOrder();
        const localFragments = orderedDeps
            .filter(name => !graph.getNodeData(name).isExternal)
            .map(name => this._generateFragment(graph.getNodeData(name).node));
        return localFragments.join('\n');
    }
    _parseImport(importStr) {
        // This is a special case when we want to ignore importing, and just use `gql` provided from somewhere else
        // Plugins that uses that will need to ensure to add import/declaration for the gql identifier
        if (importStr === 'gql') {
            return {
                moduleName: null,
                propName: 'gql',
            };
        }
        // This is a special use case, when we don't want this plugin to manage the import statement
        // of the gql tag. In this case, we provide something like `Namespace.gql` and it will be used instead.
        if (importStr.includes('.gql')) {
            return {
                moduleName: null,
                propName: importStr,
            };
        }
        const [moduleName, propName] = importStr.split('#');
        return {
            moduleName,
            propName,
        };
    }
    _generateImport({ moduleName, propName }, varName, isTypeImport) {
        const typeImport = isTypeImport && this.config.useTypeImports ? 'import type' : 'import';
        const propAlias = propName === varName ? '' : ` as ${varName}`;
        if (moduleName) {
            return `${typeImport} ${propName ? `{ ${propName}${propAlias} }` : varName} from '${moduleName}';`;
        }
        return null;
    }
    clearExtension(path) {
        const extension = extname(path);
        if (EXTENSIONS_TO_REMOVE.includes(extension)) {
            return path.replace(/\.[^/.]+$/, '');
        }
        return path;
    }
    getImports(options = {}) {
        (this._additionalImports || []).forEach(i => this._imports.add(i));
        switch (this.config.documentMode) {
            case DocumentMode.documentNode:
            case DocumentMode.documentNodeImportFragments: {
                const documentNodeImport = this._parseImport(this.config.documentNodeImport || 'graphql#DocumentNode');
                const tagImport = this._generateImport(documentNodeImport, 'DocumentNode', true);
                if (tagImport) {
                    this._imports.add(tagImport);
                }
                break;
            }
            case DocumentMode.graphQLTag: {
                const gqlImport = this._parseImport(this.config.gqlImport || 'graphql-tag');
                const tagImport = this._generateImport(gqlImport, 'gql', false);
                if (tagImport) {
                    this._imports.add(tagImport);
                }
                break;
            }
            case DocumentMode.external: {
                if (this._collectedOperations.length > 0) {
                    if (this.config.importDocumentNodeExternallyFrom === 'near-operation-file' && this._documents.length === 1) {
                        this._imports.add(`import * as Operations from './${this.clearExtension(basename(this._documents[0].location))}';`);
                    }
                    else {
                        if (!this.config.importDocumentNodeExternallyFrom) {
                            // eslint-disable-next-line no-console
                            console.warn('importDocumentNodeExternallyFrom must be provided if documentMode=external');
                        }
                        this._imports.add(`import * as Operations from '${this.clearExtension(this.config.importDocumentNodeExternallyFrom)}';`);
                    }
                }
                break;
            }
        }
        if (!options.excludeFragments && !this.config.globalNamespace) {
            const { documentMode, fragmentImports } = this.config;
            if (documentMode === DocumentMode.graphQLTag ||
                documentMode === DocumentMode.string ||
                documentMode === DocumentMode.documentNodeImportFragments) {
                fragmentImports.forEach(fragmentImport => {
                    this._imports.add(generateFragmentImportStatement(fragmentImport, 'document'));
                });
            }
        }
        return Array.from(this._imports);
    }
    buildOperation(_node, _documentVariableName, _operationType, _operationResultType, _operationVariablesTypes, _hasRequiredVariables) {
        return null;
    }
    getDocumentNodeSignature(_resultType, _variablesTypes, _node) {
        if (this.config.documentMode === DocumentMode.documentNode ||
            this.config.documentMode === DocumentMode.documentNodeImportFragments) {
            return `: DocumentNode`;
        }
        return '';
    }
    /**
     * Checks if the specific operation has variables that are non-null (required), and also doesn't have default.
     * This is useful for deciding of `variables` should be optional or not.
     * @param node
     */
    checkVariablesRequirements(node) {
        const variables = node.variableDefinitions || [];
        if (variables.length === 0) {
            return false;
        }
        return variables.some(variableDef => variableDef.type.kind === Kind.NON_NULL_TYPE && !variableDef.defaultValue);
    }
    OperationDefinition(node) {
        this._collectedOperations.push(node);
        const documentVariableName = this.convertName(node, {
            suffix: this.config.documentVariableSuffix,
            prefix: this.config.documentVariablePrefix,
            useTypesPrefix: false,
        });
        const operationType = pascalCase(node.operation);
        const operationTypeSuffix = this.getOperationSuffix(node, operationType);
        const operationResultType = this.convertName(node, {
            suffix: operationTypeSuffix + this._parsedConfig.operationResultSuffix,
        });
        const operationVariablesTypes = this.convertName(node, {
            suffix: operationTypeSuffix + 'Variables',
        });
        let documentString = '';
        if (this.config.documentMode !== DocumentMode.external) {
            // only generate exports for named queries
            if (documentVariableName !== '') {
                documentString = `${this.config.noExport ? '' : 'export'} const ${documentVariableName}${this.getDocumentNodeSignature(operationResultType, operationVariablesTypes, node)} =${this.config.pureMagicComment ? ' /*#__PURE__*/' : ''} ${this._gql(node)};`;
            }
        }
        const hasRequiredVariables = this.checkVariablesRequirements(node);
        const additional = this.buildOperation(node, documentVariableName, operationType, operationResultType, operationVariablesTypes, hasRequiredVariables);
        return [documentString, additional].filter(a => a).join('\n');
    }
}

function isMetadataFieldName(name) {
    return ['__schema', '__type'].includes(name);
}
const metadataFieldMap = {
    __schema: SchemaMetaFieldDef,
    __type: TypeMetaFieldDef,
};
class SelectionSetToObject {
    constructor(_processor, _scalars, _schema, _convertName, _getFragmentSuffix, _loadedFragments, _config, _parentSchemaType, _selectionSet) {
        this._processor = _processor;
        this._scalars = _scalars;
        this._schema = _schema;
        this._convertName = _convertName;
        this._getFragmentSuffix = _getFragmentSuffix;
        this._loadedFragments = _loadedFragments;
        this._config = _config;
        this._parentSchemaType = _parentSchemaType;
        this._selectionSet = _selectionSet;
        this._primitiveFields = [];
        this._primitiveAliasedFields = [];
        this._linksFields = [];
        this._queriedForTypename = false;
        autoBind(this);
    }
    createNext(parentSchemaType, selectionSet) {
        return new SelectionSetToObject(this._processor, this._scalars, this._schema, this._convertName.bind(this), this._getFragmentSuffix.bind(this), this._loadedFragments, this._config, parentSchemaType, selectionSet);
    }
    /**
     * traverse the inline fragment nodes recursively for colleting the selectionSets on each type
     */
    _collectInlineFragments(parentType, nodes, types) {
        if (isListType(parentType) || isNonNullType(parentType)) {
            return this._collectInlineFragments(parentType.ofType, nodes, types);
        }
        else if (isObjectType(parentType)) {
            for (const node of nodes) {
                const typeOnSchema = node.typeCondition ? this._schema.getType(node.typeCondition.name.value) : parentType;
                const { fields, inlines, spreads } = separateSelectionSet(node.selectionSet.selections);
                const spreadsUsage = this.buildFragmentSpreadsUsage(spreads);
                if (isObjectType(typeOnSchema)) {
                    this._appendToTypeMap(types, typeOnSchema.name, fields);
                    this._appendToTypeMap(types, typeOnSchema.name, spreadsUsage[typeOnSchema.name]);
                    this._collectInlineFragments(typeOnSchema, inlines, types);
                }
                else if (isInterfaceType(typeOnSchema) && parentType.getInterfaces().includes(typeOnSchema)) {
                    this._appendToTypeMap(types, parentType.name, fields);
                    this._appendToTypeMap(types, parentType.name, spreadsUsage[parentType.name]);
                    this._collectInlineFragments(typeOnSchema, inlines, types);
                }
            }
        }
        else if (isInterfaceType(parentType)) {
            const possibleTypes = getPossibleTypes(this._schema, parentType);
            for (const node of nodes) {
                const schemaType = node.typeCondition ? this._schema.getType(node.typeCondition.name.value) : parentType;
                const { fields, inlines, spreads } = separateSelectionSet(node.selectionSet.selections);
                const spreadsUsage = this.buildFragmentSpreadsUsage(spreads);
                if (isObjectType(schemaType) && possibleTypes.find(possibleType => possibleType.name === schemaType.name)) {
                    this._appendToTypeMap(types, schemaType.name, fields);
                    this._appendToTypeMap(types, schemaType.name, spreadsUsage[schemaType.name]);
                    this._collectInlineFragments(schemaType, inlines, types);
                }
                else if (isInterfaceType(schemaType) && schemaType.name === parentType.name) {
                    for (const possibleType of possibleTypes) {
                        this._appendToTypeMap(types, possibleType.name, fields);
                        this._appendToTypeMap(types, possibleType.name, spreadsUsage[possibleType.name]);
                        this._collectInlineFragments(schemaType, inlines, types);
                    }
                }
                else {
                    // it must be an interface type that is spread on an interface field
                    for (const possibleType of possibleTypes) {
                        if (!node.typeCondition) {
                            throw new Error('Invalid state. Expected type condition for interface spread on a interface field.');
                        }
                        const fragmentSpreadType = this._schema.getType(node.typeCondition.name.value);
                        // the field should only be added to the valid selections
                        // in case the possible type actually implements the given interface
                        if (isTypeSubTypeOf(this._schema, possibleType, fragmentSpreadType)) {
                            this._appendToTypeMap(types, possibleType.name, fields);
                            this._appendToTypeMap(types, possibleType.name, spreadsUsage[possibleType.name]);
                        }
                    }
                }
            }
        }
        else if (isUnionType(parentType)) {
            const possibleTypes = parentType.getTypes();
            for (const node of nodes) {
                const schemaType = node.typeCondition ? this._schema.getType(node.typeCondition.name.value) : parentType;
                const { fields, inlines, spreads } = separateSelectionSet(node.selectionSet.selections);
                const spreadsUsage = this.buildFragmentSpreadsUsage(spreads);
                if (isObjectType(schemaType) && possibleTypes.find(possibleType => possibleType.name === schemaType.name)) {
                    this._appendToTypeMap(types, schemaType.name, fields);
                    this._appendToTypeMap(types, schemaType.name, spreadsUsage[schemaType.name]);
                    this._collectInlineFragments(schemaType, inlines, types);
                }
                else if (isInterfaceType(schemaType)) {
                    const possibleInterfaceTypes = getPossibleTypes(this._schema, schemaType);
                    for (const possibleType of possibleTypes) {
                        if (possibleInterfaceTypes.find(possibleInterfaceType => possibleInterfaceType.name === possibleType.name)) {
                            this._appendToTypeMap(types, possibleType.name, fields);
                            this._appendToTypeMap(types, possibleType.name, spreadsUsage[possibleType.name]);
                            this._collectInlineFragments(schemaType, inlines, types);
                        }
                    }
                }
                else {
                    for (const possibleType of possibleTypes) {
                        this._appendToTypeMap(types, possibleType.name, fields);
                        this._appendToTypeMap(types, possibleType.name, spreadsUsage[possibleType.name]);
                    }
                }
            }
        }
    }
    _createInlineFragmentForFieldNodes(parentType, fieldNodes) {
        return {
            kind: Kind.INLINE_FRAGMENT,
            typeCondition: {
                kind: Kind.NAMED_TYPE,
                name: {
                    kind: Kind.NAME,
                    value: parentType.name,
                },
            },
            directives: [],
            selectionSet: {
                kind: Kind.SELECTION_SET,
                selections: fieldNodes,
            },
        };
    }
    buildFragmentSpreadsUsage(spreads) {
        const selectionNodesByTypeName = {};
        for (const spread of spreads) {
            const fragmentSpreadObject = this._loadedFragments.find(lf => lf.name === spread.name.value);
            if (fragmentSpreadObject) {
                const schemaType = this._schema.getType(fragmentSpreadObject.onType);
                const possibleTypesForFragment = getPossibleTypes(this._schema, schemaType);
                for (const possibleType of possibleTypesForFragment) {
                    const fragmentSuffix = this._getFragmentSuffix(spread.name.value);
                    const usage = this.buildFragmentTypeName(spread.name.value, fragmentSuffix, possibleTypesForFragment.length === 1 ? null : possibleType.name);
                    if (!selectionNodesByTypeName[possibleType.name]) {
                        selectionNodesByTypeName[possibleType.name] = [];
                    }
                    selectionNodesByTypeName[possibleType.name].push(usage);
                }
            }
        }
        return selectionNodesByTypeName;
    }
    flattenSelectionSet(selections) {
        const selectionNodesByTypeName = new Map();
        const inlineFragmentSelections = [];
        const fieldNodes = [];
        const fragmentSpreads = [];
        for (const selection of selections) {
            switch (selection.kind) {
                case Kind.FIELD:
                    fieldNodes.push(selection);
                    break;
                case Kind.INLINE_FRAGMENT:
                    inlineFragmentSelections.push(selection);
                    break;
                case Kind.FRAGMENT_SPREAD:
                    fragmentSpreads.push(selection);
                    break;
            }
        }
        if (fieldNodes.length) {
            inlineFragmentSelections.push(this._createInlineFragmentForFieldNodes(this._parentSchemaType, fieldNodes));
        }
        this._collectInlineFragments(this._parentSchemaType, inlineFragmentSelections, selectionNodesByTypeName);
        const fragmentsUsage = this.buildFragmentSpreadsUsage(fragmentSpreads);
        Object.keys(fragmentsUsage).forEach(typeName => {
            this._appendToTypeMap(selectionNodesByTypeName, typeName, fragmentsUsage[typeName]);
        });
        return selectionNodesByTypeName;
    }
    _appendToTypeMap(types, typeName, nodes) {
        if (!types.has(typeName)) {
            types.set(typeName, []);
        }
        if (nodes && nodes.length > 0) {
            types.get(typeName).push(...nodes);
        }
    }
    _buildGroupedSelections() {
        if (!this._selectionSet || !this._selectionSet.selections || this._selectionSet.selections.length === 0) {
            return {};
        }
        const selectionNodesByTypeName = this.flattenSelectionSet(this._selectionSet.selections);
        const grouped = getPossibleTypes(this._schema, this._parentSchemaType).reduce((prev, type) => {
            const typeName = type.name;
            const schemaType = this._schema.getType(typeName);
            if (!isObjectType(schemaType)) {
                throw new TypeError(`Invalid state! Schema type ${typeName} is not a valid GraphQL object!`);
            }
            const selectionNodes = selectionNodesByTypeName.get(typeName) || [];
            if (!prev[typeName]) {
                prev[typeName] = [];
            }
            const transformedSet = this.buildSelectionSetString(schemaType, selectionNodes);
            if (transformedSet) {
                prev[typeName].push(transformedSet);
            }
            return prev;
        }, {});
        return grouped;
    }
    buildSelectionSetString(parentSchemaType, selectionNodes) {
        const primitiveFields = new Map();
        const primitiveAliasFields = new Map();
        const linkFieldSelectionSets = new Map();
        let requireTypename = false;
        const fragmentsSpreadUsages = [];
        for (const selectionNode of selectionNodes) {
            if (typeof selectionNode === 'string') {
                fragmentsSpreadUsages.push(selectionNode);
            }
            else if (selectionNode.kind === 'Field') {
                if (!selectionNode.selectionSet) {
                    if (selectionNode.alias) {
                        primitiveAliasFields.set(selectionNode.alias.value, selectionNode);
                    }
                    else if (selectionNode.name.value === '__typename') {
                        requireTypename = true;
                    }
                    else {
                        primitiveFields.set(selectionNode.name.value, selectionNode);
                    }
                }
                else {
                    let selectedField = null;
                    const fields = parentSchemaType.getFields();
                    selectedField = fields[selectionNode.name.value];
                    if (isMetadataFieldName(selectionNode.name.value)) {
                        selectedField = metadataFieldMap[selectionNode.name.value];
                    }
                    if (!selectedField) {
                        continue;
                    }
                    const fieldName = getFieldNodeNameValue(selectionNode);
                    let linkFieldNode = linkFieldSelectionSets.get(fieldName);
                    if (!linkFieldNode) {
                        linkFieldNode = {
                            selectedFieldType: selectedField.type,
                            field: selectionNode,
                        };
                        linkFieldSelectionSets.set(fieldName, linkFieldNode);
                    }
                    else {
                        mergeSelectionSets(linkFieldNode.field.selectionSet, selectionNode.selectionSet);
                    }
                }
            }
        }
        const linkFields = [];
        for (const { field, selectedFieldType } of linkFieldSelectionSets.values()) {
            const realSelectedFieldType = getBaseType(selectedFieldType);
            const selectionSet = this.createNext(realSelectedFieldType, field.selectionSet);
            const isConditional = hasConditionalDirectives(field);
            linkFields.push({
                alias: field.alias ? this._processor.config.formatNamedField(field.alias.value, selectedFieldType) : undefined,
                name: this._processor.config.formatNamedField(field.name.value, selectedFieldType, isConditional),
                type: realSelectedFieldType.name,
                selectionSet: this._processor.config.wrapTypeWithModifiers(selectionSet.transformSelectionSet().split(`\n`).join(`\n  `), isConditional ? removeNonNullWrapper(selectedFieldType) : selectedFieldType),
            });
        }
        const typeInfoField = this.buildTypeNameField(parentSchemaType, this._config.nonOptionalTypename, this._config.addTypename, requireTypename, this._config.skipTypeNameForRoot);
        const transformed = [
            ...(typeInfoField ? this._processor.transformTypenameField(typeInfoField.type, typeInfoField.name) : []),
            ...this._processor.transformPrimitiveFields(parentSchemaType, Array.from(primitiveFields.values()).map(field => ({
                isConditional: hasConditionalDirectives(field),
                fieldName: field.name.value,
            }))),
            ...this._processor.transformAliasesPrimitiveFields(parentSchemaType, Array.from(primitiveAliasFields.values()).map(field => ({
                alias: field.alias.value,
                fieldName: field.name.value,
            }))),
            ...this._processor.transformLinkFields(linkFields),
        ].filter(Boolean);
        const allStrings = transformed.filter(t => typeof t === 'string');
        const allObjectsMerged = transformed
            .filter(t => typeof t !== 'string')
            .map((t) => `${t.name}: ${t.type}`);
        let mergedObjectsAsString = null;
        if (allObjectsMerged.length > 0) {
            mergedObjectsAsString = this._processor.buildFieldsIntoObject(allObjectsMerged);
        }
        const fields = [...allStrings, mergedObjectsAsString, ...fragmentsSpreadUsages].filter(Boolean);
        return this._processor.buildSelectionSetFromStrings(fields);
    }
    isRootType(type) {
        const rootType = [this._schema.getQueryType(), this._schema.getMutationType(), this._schema.getSubscriptionType()]
            .filter(Boolean)
            .map(t => t.name);
        return rootType.includes(type.name);
    }
    buildTypeNameField(type, nonOptionalTypename = this._config.nonOptionalTypename, addTypename = this._config.addTypename, queriedForTypename = this._queriedForTypename, skipTypeNameForRoot = this._config.skipTypeNameForRoot) {
        if (this.isRootType(type) && skipTypeNameForRoot && !queriedForTypename) {
            return null;
        }
        if (nonOptionalTypename || addTypename || queriedForTypename) {
            const optionalTypename = !queriedForTypename && !nonOptionalTypename;
            return {
                name: `${this._processor.config.formatNamedField('__typename')}${optionalTypename ? '?' : ''}`,
                type: `'${type.name}'`,
            };
        }
        return null;
    }
    getUnknownType() {
        return 'never';
    }
    transformSelectionSet() {
        const grouped = this._buildGroupedSelections();
        // This might happen in case we have an interface, that is being queries, without any GraphQL
        // "type" that implements it. It will lead to a runtime error, but we aim to try to reflect that in
        // build time as well.
        if (Object.keys(grouped).length === 0) {
            return this.getUnknownType();
        }
        return Object.keys(grouped)
            .map(typeName => {
            const relevant = grouped[typeName].filter(Boolean);
            if (relevant.length === 0) {
                return null;
            }
            else if (relevant.length === 1) {
                return relevant[0];
            }
            else {
                return `( ${relevant.join(' & ')} )`;
            }
        })
            .filter(Boolean)
            .join(' | ');
    }
    transformFragmentSelectionSetToTypes(fragmentName, fragmentSuffix, declarationBlockConfig) {
        const grouped = this._buildGroupedSelections();
        const subTypes = Object.keys(grouped)
            .map(typeName => {
            const possibleFields = grouped[typeName].filter(Boolean);
            if (possibleFields.length === 0) {
                return null;
            }
            const declarationName = this.buildFragmentTypeName(fragmentName, fragmentSuffix, typeName);
            return { name: declarationName, content: possibleFields.join(' & ') };
        })
            .filter(Boolean);
        if (subTypes.length === 1) {
            return new DeclarationBlock(declarationBlockConfig)
                .export()
                .asKind('type')
                .withName(this.buildFragmentTypeName(fragmentName, fragmentSuffix))
                .withContent(subTypes[0].content).string;
        }
        return [
            ...subTypes.map(t => new DeclarationBlock(declarationBlockConfig)
                .export(this._config.exportFragmentSpreadSubTypes)
                .asKind('type')
                .withName(t.name)
                .withContent(t.content).string),
            new DeclarationBlock(declarationBlockConfig)
                .export()
                .asKind('type')
                .withName(this.buildFragmentTypeName(fragmentName, fragmentSuffix))
                .withContent(subTypes.map(t => t.name).join(' | ')).string,
        ].join('\n');
    }
    buildFragmentTypeName(name, suffix, typeName = '') {
        return this._convertName(name, {
            useTypesPrefix: true,
            suffix: typeName ? `_${typeName}_${suffix}` : suffix,
        });
    }
}

class BaseSelectionSetProcessor {
    constructor(config) {
        this.config = config;
    }
    buildFieldsIntoObject(allObjectsMerged) {
        return `{ ${allObjectsMerged.join(', ')} }`;
    }
    buildSelectionSetFromStrings(pieces) {
        if (pieces.length === 0) {
            return null;
        }
        else if (pieces.length === 1) {
            return pieces[0];
        }
        else {
            return `(\n  ${pieces.join(`\n  & `)}\n)`;
        }
    }
    transformPrimitiveFields(_schemaType, _fields) {
        throw new Error(`Please override "transformPrimitiveFields" as part of your BaseSelectionSetProcessor implementation!`);
    }
    transformAliasesPrimitiveFields(_schemaType, _fields) {
        throw new Error(`Please override "transformAliasesPrimitiveFields" as part of your BaseSelectionSetProcessor implementation!`);
    }
    transformLinkFields(_fields) {
        throw new Error(`Please override "transformLinkFields" as part of your BaseSelectionSetProcessor implementation!`);
    }
    transformTypenameField(_type, _name) {
        throw new Error(`Please override "transformTypenameField" as part of your BaseSelectionSetProcessor implementation!`);
    }
}

class PreResolveTypesProcessor extends BaseSelectionSetProcessor {
    transformTypenameField(type, name) {
        return [
            {
                type,
                name,
            },
        ];
    }
    transformPrimitiveFields(schemaType, fields) {
        if (fields.length === 0) {
            return [];
        }
        return fields.map(field => {
            const fieldObj = schemaType.getFields()[field.fieldName];
            const baseType = getBaseType(fieldObj.type);
            let typeToUse = baseType.name;
            const useInnerType = field.isConditional && isNonNullType(fieldObj.type);
            if (isEnumType(baseType)) {
                typeToUse =
                    (this.config.namespacedImportName ? `${this.config.namespacedImportName}.` : '') +
                        this.config.convertName(baseType.name, { useTypesPrefix: this.config.enumPrefix });
            }
            else if (this.config.scalars[baseType.name]) {
                typeToUse = this.config.scalars[baseType.name];
            }
            const name = this.config.formatNamedField(field.fieldName, useInnerType ? baseType : fieldObj.type);
            const wrappedType = this.config.wrapTypeWithModifiers(typeToUse, useInnerType ? baseType : fieldObj.type);
            return {
                name,
                type: wrappedType,
            };
        });
    }
    transformAliasesPrimitiveFields(schemaType, fields) {
        if (fields.length === 0) {
            return [];
        }
        return fields.map(aliasedField => {
            if (aliasedField.fieldName === '__typename') {
                const name = this.config.formatNamedField(aliasedField.alias, null);
                return {
                    name,
                    type: `'${schemaType.name}'`,
                };
            }
            else {
                const fieldObj = schemaType.getFields()[aliasedField.fieldName];
                const baseType = getBaseType(fieldObj.type);
                let typeToUse = this.config.scalars[baseType.name] || baseType.name;
                if (isEnumType(baseType)) {
                    typeToUse =
                        (this.config.namespacedImportName ? `${this.config.namespacedImportName}.` : '') +
                            this.config.convertName(baseType.name, { useTypesPrefix: this.config.enumPrefix });
                }
                const name = this.config.formatNamedField(aliasedField.alias, fieldObj.type);
                const wrappedType = this.config.wrapTypeWithModifiers(typeToUse, fieldObj.type);
                return {
                    name,
                    type: wrappedType,
                };
            }
        });
    }
    transformLinkFields(fields) {
        if (fields.length === 0) {
            return [];
        }
        return fields.map(field => ({
            name: field.alias || field.name,
            type: field.selectionSet,
        }));
    }
}

function optimizeOperations(schema, documents, options) {
    const newDocuments = optimizeDocuments(schema, documents.map(s => s.document), options);
    return newDocuments.map(document => ({
        location: 'optimized by relay',
        document,
    }));
}

export { BaseDocumentsVisitor, BaseResolversVisitor, BaseSelectionSetProcessor, BaseTypesVisitor, BaseVisitor, ClientSideBaseVisitor, DEFAULT_AVOID_OPTIONALS, DEFAULT_DECLARATION_KINDS, DEFAULT_SCALARS, DeclarationBlock, DocumentMode, OMIT_TYPE, OperationVariablesToObject, PreResolveTypesProcessor, REQUIRE_FIELDS_TYPE, SelectionSetToObject, block, breakLine, buildMapperImport, buildScalars, buildScalarsFromConfig, clearExtension, convertFactory, convertNameParts, fixLocalFilePath, generateFragmentImportStatement, generateImportStatement, getBaseTypeNode, getConfigValue, getFieldNodeNameValue, getPossibleTypes, getRootTypeNames, hasConditionalDirectives, indent, indentMultiline, isExternalMapper, isExternalMapperType, isRootType, isStringValueNode, mergeSelectionSets, normalizeAvoidOptionals, normalizeDeclarationKind, optimizeOperations, parseEnumValues, parseMapper, quoteIfNeeded, removeDescription, resolveImportSource, resolveRelativeImport, separateSelectionSet, stripMapperTypeInterpolation, transformComment, transformMappers, wrapTypeNodeWithModifiers, wrapTypeWithModifiers, wrapWithSingleQuotes };
//# sourceMappingURL=index.esm.js.map
