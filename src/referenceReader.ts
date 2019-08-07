/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import {
    TreeVisitor, TreeTraverser
} from './types';
import { SymbolKind, PhpSymbol, SymbolModifier, symbolKindToString } from './symbol';
import { SymbolStore, SymbolTable } from './symbolStore';
import { ParsedDocument, NodeTransform } from './parsedDocument';
import { NameResolver } from './nameResolver';
import { Predicate } from './types';
import * as lsp from 'vscode-languageserver-types';
import { TypeString, TypeResolvable } from './typeString';
import { MemberMergeStrategy } from './typeAggregate';
import * as util from './utils';
import { PhpDocParser, Tag } from './phpDoc';
import { Reference, Scope, ReferenceTable } from './reference';
import { SymbolIndex } from './indexes/symbolIndex';
import { SyntaxNode } from 'tree-sitter';
import { SymbolReader } from './symbolReader';

const HEADER_TRANSFORM_KIND = new Set<string>([
    'class_name',
    'interface_name',
    'function_name',
    'trait_name',
    'const_name',
    'method_name',
    'class_const_name',
]);

const HEADER_SYMBOL_KIND_MAPPING = new Map<SymbolKind, string>([
    [SymbolKind.Class, 'class_name'],
    [SymbolKind.Interface, 'interface_name'],
    [SymbolKind.Function, 'function_name'],
    [SymbolKind.Trait, 'trait_name'],
    [SymbolKind.Constant, 'const_name'],
    [SymbolKind.Method, 'method_name'],
    [SymbolKind.ClassConstant, 'class_const_name'],
]);

const HEADER_NODE_TYPE_MAPPING = new Map<string, SymbolKind>([
    ['class_declaration', SymbolKind.Class],
    ['interface_declaration', SymbolKind.Interface],
    ['function_definition', SymbolKind.Function],
    ['trait_declaration', SymbolKind.Trait],
    ['const_element', SymbolKind.Constant],
]);

const HEADER_SCOPED_NODE_TYPE_MAPPING = new Map<string, SymbolKind>([
    ['class_const_declaration', SymbolKind.ClassConstant],
    ['method_declaration', SymbolKind.Method],
]);

interface TypeNodeTransform extends NodeTransform {
    type: string | TypeResolvable;
}

export interface ReferenceNodeTransform extends NodeTransform {
    reference: Reference;
}

interface VariableNodeTransform extends NodeTransform {
    variable: Variable;
}

interface TextNodeTransform extends NodeTransform {
    text: string;
}

function symbolsToTypeReduceFn(prev: string, current: PhpSymbol, index: number, array: PhpSymbol[]) {
    return TypeString.merge(prev, PhpSymbol.type(current));
}

export class ReferenceReader implements TreeVisitor<SyntaxNode> {

    private _transformStack: (NodeTransform | null)[];
    private _variableTable: VariableTable;
    private _classStack: PhpSymbol[];
    private _scopeStack: Scope[];
    private _symbols: PhpSymbol[];
    private _lastVarTypehints: Tag[] | null;
    private _symbolOffset = 0;

    constructor(
        public doc: ParsedDocument,
        public nameResolver: NameResolver,
        public symbolStore: SymbolStore,
        namedSymbols: PhpSymbol[],
        globalVariables: PhpSymbol[]
    ) {
        const excludeMask = SymbolKind.ClassConstant | SymbolKind.Constant;

        this._transformStack = [];
        this._variableTable = new VariableTable();
        this._classStack = [];
        this._symbols = namedSymbols.filter(symbol => (symbol.kind & excludeMask) === 0);

        const fileSymbol = this.shiftSymbol(SymbolKind.File);
        const fileRange = fileSymbol.location ? fileSymbol.location.range : lsp.Range.create(
            lsp.Position.create(0, 0), lsp.Position.create(0, 0)
        );
        this._scopeStack = [
            Scope.create(lsp.Location.create(this.doc.uri, util.cloneRange(fileRange)))
        ]; //file/root node

        for (const globalVariable of globalVariables) {
            if (globalVariable.type === undefined) {
                continue;
            }

            this._variableTable.setVariable(Variable.create(globalVariable.name, globalVariable.type));
        }
    }

    get refTable() {
        return new ReferenceTable(this.doc.uri, this._scopeStack[0]);
    }

    private shiftSymbol(expectedKind: SymbolKind) {
        if (this._symbolOffset >= this._symbols.length) {
            throw new Error('CodingError: ' +
                this.doc.uri + ' symbol tree is not in sync with ReferenceReader');
        }

        const result = this._symbols[this._symbolOffset++];
        // if ((expectedKind & result.kind) === 0) {
        //     console.log(`Expected ${symbolKindToString(expectedKind)} but got ${symbolKindToString(result.kind)} ${JSON.stringify(result)}`);
        // }

        return result;
    }

    private currentSymbol() {
        if (this._symbolOffset >= this._symbols.length) {
            return undefined;
        }

        return this._symbols[this._symbolOffset];
    }

    private _currentClassName() {
        let c = this._classStack.length ? this._classStack[this._classStack.length - 1] : undefined;
        return c ? c.name : '';
    }

    preorder(node: SyntaxNode, spine: SyntaxNode[]) {

        const parent = spine.length ? spine[spine.length - 1] : null;
        const parentTransform = this._transformStack.length ?
            this._transformStack[this._transformStack.length - 1] : null;

        switch (node.type) {

            case 'ERROR':
                this._transformStack.push(null);
                break;

            case 'namespace_definition':
                {
                    const s = this.shiftSymbol(SymbolKind.Namespace);
                    this._scopeStackPush(Scope.create(this.doc.nodeLocation(node)));
                    this.nameResolver.namespace = s;
                    this._transformStack.push(new NamespaceDefinitionTransform());
                }
                break;

            case 'function_call_expression':
                if (parentTransform) {
                    this._transformStack.push(new FunctionCallExpressionTransform(this._referenceSymbols));
                } else {
                    this._transformStack.push(null);
                }
                break;

            case 'simple_parameter':
                this._transformStack.push(new ParameterDeclarationTransform());
                break;

            case 'namespace_use_declaration':
                this._transformStack.push(new NamespaceUseDeclarationTransform());
                break;

            case 'namespace_use_clause':
            case 'namespace_use_group_clause_2':
                {
                    const currentSymbol = this.currentSymbol();
                    if (
                        currentSymbol && currentSymbol.modifiers &&
                        (currentSymbol.modifiers & SymbolModifier.Use) > 0
                    ) {
                        this.nameResolver.rules.push(this.shiftSymbol(
                            SymbolKind.Class | SymbolKind.Function | SymbolKind.Constant
                        ));
                    }
                    this._transformStack.push(new NamespaceUseClauseTransform(node.type));
                    break;
                }

            case 'function_definition':
                this._transformStack.push(null);
                if (parent && parent.type !== 'method_declaration') {
                    this._functionDeclaration(node);
                }
                break;

            case 'method_declaration':
            case 'constructor_declaration':
                this._transformStack.push(null);
                this._methodDeclaration(node);
                break;

            case 'class_declaration':
            case 'trait_declaration':
            case 'interface_declaration':
                {
                    let symbolKind = 0;
                    if (node.type === 'class_declaration') {
                        symbolKind = SymbolKind.Class;
                    } else if (node.type === 'interface_declaration') {
                        symbolKind = SymbolKind.Interface;
                    } else if (node.type === 'trait_declaration') {
                        symbolKind = SymbolKind.Trait;
                    }

                    const location = this.doc.nodeLocation(node);
                    const s = this.shiftSymbol(symbolKind) || PhpSymbol.create(SymbolKind.Class, '', location);
                    this._scopeStackPush(Scope.create(location));
                    this.nameResolver.pushClass(s);
                    this._classStack.push(s);
                    this._variableTable.pushScope();
                    this._variableTable.setVariable(Variable.create('$this', s.name));
                    this._transformStack.push(null);
                }
                break;

            case 'anonymous_function_creation_expression':
                this._anonymousFunctionCreationExpression(node);
                this._transformStack.push(null);
                break;

            case 'if_statement':
            case 'switch_statement':
                this._transformStack.push(null);
                this._variableTable.pushBranch();
                break;

            case 'case_statement':
            case 'default_statement':
            case 'else_clause':
                this._transformStack.push(null);
                this._variableTable.popBranch();
                this._variableTable.pushBranch();
                break;

            case 'assignment_expression':
                this._transformStack.push(new SimpleAssignmentExpressionTransform(
                    'assignment_expression', this._lastVarTypehints
                ));
                break;

            case 'binary_expression':
                {
                    // Second child is the operator
                    const operator = node.child(1);

                    if (!operator) {
                        this._transformStack.push(null);
                        break;
                    }

                    if (operator.type === 'instanceof') {
                        this._transformStack.push(new InstanceOfExpressionTransform());
                    } else if (operator.type === '??') {
                        this._transformStack.push(new CoalesceExpressionTransform());
                    } else {
                        this._transformStack.push(null);
                    }
                    break;
                }

            case 'foreach_statement':
                this._transformStack.push(new ForeachStatementTransform());
                break;

            case 'foreach_collection':
                this._transformStack.push(new ForeachCollectionTransform());
                break;

            case 'foreach_value':
                this._transformStack.push(new ForeachValueTransform());
                break;

            case 'catch_clause':
                this._transformStack.push(new CatchClauseTransform());
                break;

            case 'catch_name_list':
                this._transformStack.push(new CatchNameListTransform());
                break;

            case 'qualified_name':
                this._transformStack.push(
                    new QualifiedNameTransform(this._nameSymbolType(parent), this.doc.nodeLocation(node), this.nameResolver)
                );
                break;

            case 'namespace_name_as_prefix':
                this._transformStack.push(new NamespaceNameAsPrefixTransform());
                break;

            case '__construct':
                this._transformStack.push(new HeaderTransform(
                    this.nameResolver, this.doc, node,
                    SymbolKind.Method,
                    this._currentClassName()
                ));
                break;

            case 'name':
                if (HEADER_NODE_TYPE_MAPPING.has(parent.type)) {
                    if (parent.parent && HEADER_SCOPED_NODE_TYPE_MAPPING.has(parent.parent.type)) {
                        this._transformStack.push(new HeaderTransform(
                            this.nameResolver, this.doc, node,
                            HEADER_SCOPED_NODE_TYPE_MAPPING.get(parent.parent.type),
                            this._currentClassName()
                        ));
                        break;
                    }

                    this._transformStack.push(new HeaderTransform(
                        this.nameResolver, this.doc, node, HEADER_NODE_TYPE_MAPPING.get(parent.type)
                    ));
                    break;
                }
                if (this._isScope(parent)) {
                    this._transformStack.push(
                        new MemberNameTransform(node, this.doc.nodeLocation(node))
                    );
                    break;
                }
                this._transformStack.push(new TokenTransform(node, this.doc));
                break;

            case 'namespace_name':
                this._transformStack.push(new NamespaceNameTransform(node, this.doc));
                break;

            case 'variable_name':
                let isGlobal = false;

                for (let i = spine.length - 1; i >= 0; i--) {
                    if ((spine[i]).type == 'global_declaration') {
                        isGlobal = true;
                        break;
                    }
                }

                if (!isGlobal) {
                    this._transformStack.push(new SimpleVariableTransform(this.doc.nodeLocation(node), this._variableTable));
                } else {
                    this._transformStack.push(new GlobalVariableTransform(this.doc.nodeLocation(node), this._variableTable));
                }
                break;

            case 'dereferencable_expression':
                this._transformStack.push(new DereferencableExpression());
                break;

            case 'list_literal':
                this._transformStack.push(new ListIntrinsicTransform());
                break;

            case 'array_creation_expression':
                if (parentTransform) {
                    this._transformStack.push(new ArrayInititialiserListTransform());
                } else {
                    this._transformStack.push(null);
                }
                break;

            case 'array_element_initializer':
                if (parentTransform) {
                    this._transformStack.push(new ArrayValueTransform());
                } else {
                    this._transformStack.push(null);
                }
                break;

            case 'subscript_expression':
                if (parentTransform) {
                    this._transformStack.push(new SubscriptExpressionTransform());
                } else {
                    this._transformStack.push(null);
                }
                break;

            case 'scoped_call_expression':
                this._transformStack.push(
                    new MemberAccessExpressionTransform('scoped_call_expression', SymbolKind.Method, this._referenceSymbols)
                );
                break;

            case 'scoped_property_access_expression':
                this._transformStack.push(
                    new MemberAccessExpressionTransform('scoped_property_access_expression', SymbolKind.Property, this._referenceSymbols)
                );
                break;

            case 'class_constant_access_expression':
                this._transformStack.push(
                    new MemberAccessExpressionTransform('class_constant_access_expression', SymbolKind.ClassConstant, this._referenceSymbols)
                );
                break;

            case 'member_access_expression':
                this._transformStack.push(
                    new MemberAccessExpressionTransform('member_access_expression', SymbolKind.Property, this._referenceSymbols)
                );
                break;

            case 'member_call_expression':
                this._transformStack.push(
                    new MemberAccessExpressionTransform('member_call_expression', SymbolKind.Method, this._referenceSymbols)
                );
                break;

            case 'member_name':
                this._transformStack.push(
                    new MemberNameTransform(node, this.doc.nodeLocation(node))
                );
                break;

            case 'anonymous_function_creation_expression':
                this._transformStack.push(new AnonymousFunctionUseVariableTransform());
                break;

            case 'object_creation_expression':
                {
                    if (SymbolReader.isAnonymousClassDeclaration(node)) {
                        const location = this.doc.nodeLocation(node);
                        const s = this.shiftSymbol(SymbolKind.Class) || PhpSymbol.create(SymbolKind.Class, '', location);
                        this._scopeStackPush(Scope.create(location));
                        this.nameResolver.pushClass(s);
                        this._classStack.push(s);
                        this._variableTable.pushScope();
                        this._variableTable.setVariable(Variable.create('$this', s.name));
                        this._transformStack.push(null);
                        break;
                    }

                    // ClassTypeDesignator
                    const secondChild = node.child(1);
                    if (
                        secondChild &&
                        (secondChild.type == 'qualified_name' || secondChild.type === 'new_variable')
                    ) {
                        this._transformStack.push(new TypeDesignatorTransform('_class_type_designator'));
                        break;
                    }

                    if (parentTransform) {
                        this._transformStack.push(new ObjectCreationExpressionTransform());
                        break;
                    }

                    this._transformStack.push(null);
                    break;
                }

            case 'relative_scope':
                let context = this._classStack.length ? this._classStack[this._classStack.length - 1] : null;
                let name = context ? context.name : '';
                this._transformStack.push(new RelativeScopeTransform(name, this.doc.nodeLocation(node)));
                break;

            case 'property_element':
                this._transformStack.push(new PropertyElementTransform(this._currentClassName()));
                break;

            case 'conditional_expression':
                if (parentTransform) {
                    this._transformStack.push(new TernaryExpressionTransform());
                } else {
                    this._transformStack.push(null);
                }
                break;

            case 'comment':
                {
                    this._transformStack.push(null);
                    const phpDoc = PhpDocParser.parse(node.text);
                    if (phpDoc) {
                        this._lastVarTypehints = phpDoc.varTags;

                        if (!this._lastVarTypehints) {
                            break;
                        }

                        for (const varTag of this._lastVarTypehints) {
                            varTag.typeString = TypeString.nameResolve(varTag.typeString, this.nameResolver);
                            this._variableTable.setVariable(Variable.create(varTag.name, varTag.typeString));
                        }
                    }
                    break;
                }

            case '{':
            case '}':
            case ';':
                this._lastVarTypehints = null;
                this._transformStack.push(null);
                break;

            default:
                {
                    this._transformStack.push(new TokenTransform(node, this.doc));
                    break;
                }
        }

        return true;

    }

    postorder(node: SyntaxNode, spine: SyntaxNode[]) {

        const transform = this._transformStack.pop();
        const parentTransform = this._transformStack.length ? this._transformStack[this._transformStack.length - 1] : null;
        const scope = this._scopeStack.length ? this._scopeStack[this._scopeStack.length - 1] : null;

        if (parentTransform && transform && parentTransform.push) {
            parentTransform.push(transform);
        }

        switch (node.type) {

            case 'qualified_name':
            case 'variable_name':
            case 'scoped_call_expression':
            case 'member_call_expression':
            case 'member_access_expression':
            case 'class_constant_access_expression':
            case 'scoped_property_access_expression':
            case 'namespace_use_clause':
            case 'namespace_use_group_clause_1':
            case 'namespace_use_group_clause_2':
            case 'class_declaration':
            case 'interface_declaration':
            case 'trait_declaration':
            case 'function_declaration':
            case 'const_element':
            case 'property_element':
            case 'class_const_declaration':
            case 'method_declaration':
            case 'namespace_definition':
            case 'variadic_parameter':
            case 'simple_parameter':
            case 'anonymous_function_use_clause':
            case 'relative_scope':
                if (scope && transform) {
                    let ref = (<ReferenceNodeTransform>transform).reference;

                    if (transform instanceof GlobalVariableTransform) {
                        this._variableTable.setVariable(Variable.create(ref.name, ref.type || ''));
                    }

                    if (ref) {
                        scope.children.push(ref);
                    }
                }

                if (node.type === 'namespace_definition') {
                    this._scopeStack.pop();
                }


                switch (node.type) {
                    case 'class_declaration':
                    case 'trait_declaration':
                    case 'interface_declaration':
                        this.nameResolver.popClass();
                        this._classStack.pop();
                        this._scopeStack.pop();
                        this._variableTable.popScope();
                        break;
                }
                break;

            case 'object_creation_expression':
                {
                    const parent = spine.length ? spine[spine.length - 1] : null;
                    if (SymbolReader.isAnonymousClassDeclaration(node)) {
                        this.nameResolver.popClass();
                        this._classStack.pop();
                        this._scopeStack.pop();
                        this._variableTable.popScope();
                    }
                    break;
                }

            case 'assignment_expression':
                this._variableTable.setVariables((<SimpleAssignmentExpressionTransform>transform).variables);
                break;

            case 'binary_expression':
                {
                    // Second child is operator
                    const operator = node.child(1);

                    if (!operator) {

                    } else if (operator.type === 'instanceof') {
                        const variable = (<InstanceOfExpressionTransform>transform).variable;

                        if (variable) {
                            this._variableTable.setVariable(variable);
                        }
                    }
                    break;
                }

            case 'foreach_value':
                this._variableTable.setVariables((<ForeachStatementTransform>parentTransform).variables);
                break;

            case 'if_statement':
            case 'switch_statement':
                this._variableTable.popBranch();
                this._variableTable.pruneBranches();
                break;

            case 'function_definition':
            case 'anonymous_function_creation_expression':
                this._scopeStack.pop();
                this._variableTable.popScope();
                break;

            case 'name':
            case '__construct':
                {
                    if (scope && transform && HEADER_TRANSFORM_KIND.has(transform.kind)) {
                        const ref = (<ReferenceNodeTransform>transform).reference;
                        if (ref) {
                            scope.children.push(ref);
                        }
                    }
                    break;
                }

            default:
                break;
        }

    }

    private _scopeStackPush(scope: Scope) {
        if (this._scopeStack.length) {
            this._scopeStack[this._scopeStack.length - 1].children.push(scope);
        }
        this._scopeStack.push(scope);
    }

    private _isScope(parent: SyntaxNode | null): boolean {
        if (!parent) {
            return false;
        }

        return [
            'class_constant_access_expression',
            'function_call_expression',
            'object_creation_expression',
        ].includes(parent.type);
    }

    private _nameSymbolType(parent: SyntaxNode | null): SymbolKind {
        if (!parent) {
            return SymbolKind.Constant;
        }

        switch (parent.type) {
            case 'function_call_expression':
                return SymbolKind.Function;
            case 'trait_use_clause':
            case 'class_declaration':
            case 'class_base_clause':
            case 'binary_expression':
            case 'catch_clause':
            case 'catch_name_list':
            case 'scoped_call_expression':
            case 'class_constant_access_expression':
            case 'scoped_property_access_expression':
            case 'namespace_use_clause':
                if (parent.type === 'binary_expression') {
                    const operator = parent.child(1);
                    if (operator !== null && operator.type === 'instanceof') {
                        return SymbolKind.Class;
                    }

                    break;
                }

                return SymbolKind.Class;
            case 'class_interface_clause':
            case 'interface_base_clause':
                return SymbolKind.Interface;
            case 'object_creation_expression':
                return SymbolKind.Constructor;
        }

        return SymbolKind.Constant;
    }

    private _methodDeclaration(node: SyntaxNode) {

        let scope = Scope.create(this.doc.nodeLocation(node));
        this._scopeStackPush(scope);
        this._variableTable.pushScope(['$this']);
        let symbol = this.shiftSymbol(SymbolKind.Method);

        if (symbol) {
            let fn = (x: PhpSymbol) => {
                return x.kind === SymbolKind.Method && symbol.name === x.name;
            };
            //lookup method on aggregate to inherit doc
            let children = symbol && symbol.children ? symbol.children : [];
            let param: PhpSymbol;
            for (let n = 0, l = children.length; n < l; ++n) {
                param = children[n];
                if (param.kind === SymbolKind.Parameter) {
                    this._variableTable.setVariable(Variable.create(param.name, PhpSymbol.type(param)));
                }
            }
        }
    }

    private _functionDeclaration(node: SyntaxNode) {
        let symbol = this.shiftSymbol(SymbolKind.Function);
        this._scopeStackPush(Scope.create(this.doc.nodeLocation(node)));
        this._variableTable.pushScope();

        let children = symbol && symbol.children ? symbol.children : [];
        let param: PhpSymbol;
        for (let n = 0, l = children.length; n < l; ++n) {
            param = children[n];
            if (param.kind === SymbolKind.Parameter) {
                this._variableTable.setVariable(Variable.create(param.name, PhpSymbol.type(param)));
            }
        }
    }

    private _anonymousFunctionCreationExpression(node: SyntaxNode) {
        let symbol = this.shiftSymbol(SymbolKind.Function);
        this._scopeStackPush(Scope.create(this.doc.nodeLocation(node)));
        let carry: string[] = ['$this'];
        let children = symbol && symbol.children ? symbol.children : [];
        let s: PhpSymbol;

        for (let n = 0, l = children.length; n < l; ++n) {
            s = children[n];
            if (s.kind === SymbolKind.Variable && s.modifiers && (s.modifiers & SymbolModifier.Use) > 0) {
                carry.push(s.name);
            }
        }

        this._variableTable.pushScope(carry);

        for (let n = 0, l = children.length; n < l; ++n) {
            s = children[n];
            if (s.kind === SymbolKind.Parameter) {
                this._variableTable.setVariable(Variable.create(s.name, PhpSymbol.type(s)));
            }
        }

    }

    private _referenceSymbols: ReferenceSymbolDelegate = (ref) => {
        return this.symbolStore.findSymbolsByReference(ref, MemberMergeStrategy.Documented);
    }

}

class TokenTransform implements TypeNodeTransform, TextNodeTransform {

    constructor(public node: SyntaxNode, public doc: ParsedDocument) { }

    get kind() {
        return this.node.type;
    }

    get text() {
        return this.node.text;
    }

    get location() {
        return this.doc.nodeLocation(this.node);
    }

    get type() {
        switch (this.kind) {
            case 'float':
                return 'float';
            case 'string':
                return 'string';
            case 'integer':
                return 'int';
            case 'name':
                {
                    let lcName = this.text.toLowerCase();
                    return lcName === 'true' || lcName === 'false' ? 'bool' : '';
                }
            default:
                return '';
        }
    }

    push(transform: NodeTransform) { }

}

class NamespaceNameTransform implements NodeTransform {

    kind = 'namespace_name';
    private _parts: string[];

    constructor(public node: SyntaxNode, public document: ParsedDocument) {
        this._parts = [];
    }

    get location() {
        return this.document.nodeLocation(this.node);
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'name') {
            this._parts.push((<TokenTransform>transform).text);
        }
    }

    get text() {
        return this._parts.join('\\');
    }

}

class NamespaceNameAsPrefixTransform implements NodeTransform {
    kind = 'namespace_name_as_prefix';
    text: string = '';

    push(transform: NodeTransform) {
        if (transform.kind === 'namespace_name') {
            this.text = (<NamespaceNameTransform>transform).text;
        }
    }
}

class PropertyElementTransform implements ReferenceNodeTransform {

    kind = 'property_element';
    reference: Reference;
    private _scope = '';

    constructor(scope: string) {
        this._scope = scope;
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'variable_name') {
            const ref = (<SimpleVariableTransform>transform).reference;
            const name = ref.name;
            const loc = ref.location;
            this.reference = Reference.create(SymbolKind.Property, name, loc);
            this.reference.scope = this._scope;
        }
    }

}

class HeaderTransform implements ReferenceNodeTransform {

    kind = 'unknown_name';
    reference: Reference;

    constructor(
        public nameResolver: NameResolver, doc: ParsedDocument,
        node: SyntaxNode, kind: SymbolKind, scope?: string
    ) {
        if (HEADER_SYMBOL_KIND_MAPPING.has(kind)) {
            this.kind = HEADER_SYMBOL_KIND_MAPPING.get(kind);
        }

        const name = node.text;
        const loc = doc.nodeLocation(node);
        this.reference = Reference.create(kind, this.nameResolver.resolveRelative(name), loc);

        if (scope !== undefined) {
            this.reference.scope = scope;
        }
    }

    push(transform: NodeTransform) { }

}

class NamespaceUseDeclarationTransform implements NodeTransform {

    kind = 'namespace_use_declaration';
    references: Reference[];
    private _kind = SymbolKind.Class;
    private _prefix = '';

    constructor() {
        this.references = [];
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'const') {
            this._kind = SymbolKind.Constant;
        } else if (transform.kind === 'function') {
            this._kind = SymbolKind.Function;
        } else if (transform.kind === 'namespace_name') {
            this._prefix = (<NamespaceNameTransform>transform).text;
        } else if (transform.kind === 'namespace_use_clause') {
            const ref = (<NamespaceUseClauseTransform>transform).reference;
            const prefix = this._prefix ? this._prefix + '\\' : '';

            ref.name = prefix + ref.name;
            if (!ref.kind) {
                ref.kind = this._kind;
            }

            this.references.push(ref);
        }
    }

}

class NamespaceUseClauseTransform implements ReferenceNodeTransform {

    reference: Reference;

    constructor(public kind: string) {
        this.reference = Reference.create(0, '', lsp.Location.create('', lsp.Range.create(
            lsp.Position.create(0, 0),
            lsp.Position.create(0, 0)
        )));
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'function') {
            this.reference.kind = SymbolKind.Function;
        } else if (transform.kind === 'const') {
            this.reference.kind = SymbolKind.Constant;
        } else if (transform.kind === 'namespace_name') {
            this.reference.name = (<NamespaceNameTransform>transform).text;
            this.reference.location = (<NamespaceNameTransform>transform).location;
        }
    }

}

type ReferenceSymbolDelegate = (ref: Reference) => Promise<PhpSymbol[]>;

class CatchClauseTransform implements VariableNodeTransform {

    kind = 'catch_clause';
    private _varType = '';
    private _varName = '';

    push(transform: NodeTransform) {
        if (transform.kind === 'catch_name_list') {
            this._varType = (<CatchNameListTransform>transform).type;
        } else if (transform.kind === 'variable_name') {
            this._varName = (<TokenTransform>transform).text;
        }
    }

    get variable() {
        // Syntax error if name and type are missing
        return this._varName && this._varType ?
            Variable.create(this._varName, this._varType) : Variable.create('', '');
    }

}

class CatchNameListTransform implements TypeNodeTransform {

    kind = 'catch_name_list';
    type = '';

    push(transform: NodeTransform) {
        let ref = (<ReferenceNodeTransform>transform).reference;
        if (ref) {
            this.type = TypeString.merge(this.type, ref.name);
        }
    }

}

class AnonymousFunctionUseVariableTransform implements ReferenceNodeTransform {
    kind = 'anonymous_function_use_clause';
    reference: Reference;

    push(transform: NodeTransform) {
        if (transform.kind === 'variable_name') {
            this.reference = Reference.create(SymbolKind.Variable, (<TokenTransform>transform).text, (<TokenTransform>transform).location);
        }
    }
}

class ForeachStatementTransform implements NodeTransform {

    kind = 'foreach_statement';
    variables: Variable[];
    private _type: string | TypeResolvable = '';

    constructor() {
        this.variables = [];
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'foreach_collection') {
            this._type = async (): Promise<string> => {
                let transformType = await TypeString.resolve((<ForeachCollectionTransform>transform).type);
                return TypeString.arrayDereference(transformType)
            };
        } else if (transform.kind === 'foreach_value') {
            let vars = (<ForeachValueTransform>transform).variables;

            for (const variable of vars) {
                const newVariable = Variable.create(variable.name, async () => {
                    return Variable.resolveBaseVariable(variable, await TypeString.resolve(this._type));
                });

                this.variables.push(newVariable);
            }
        }
    }

}

export interface Variable {
    name: string;
    arrayDereferenced: number;
    type: string | TypeResolvable;
}

export namespace Variable {

    export function create(name: string, type: string | TypeResolvable) {
        return <Variable>{
            name: name,
            arrayDereferenced: 0,
            type: type
        };
    }

    export function resolveBaseVariable(variable: Variable, type: string): string {
        let deref = variable.arrayDereferenced;
        if (deref > 0) {
            while (deref-- > 0) {
                type = TypeString.arrayReference(type);
            }
        } else if (deref < 0) {
            while (deref++ < 0) {
                type = TypeString.arrayDereference(type);
            }
        }
        return type;
    }
}

class ForeachValueTransform implements NodeTransform {

    kind = 'foreach_value';
    variables: Variable[];

    constructor() {
        this.variables = [];
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'variable_name') {
            let ref = (<SimpleVariableTransform>transform).reference;
            this.variables = [{ name: ref.name, arrayDereferenced: 0, type: ref.type || '' }];
        } else if (transform.kind === 'list_literal') {
            this.variables = (<ListIntrinsicTransform>transform).variables;
        }
    }

}

class ForeachCollectionTransform implements TypeNodeTransform {

    kind = 'foreach_collection';
    type: string | TypeResolvable = '';

    push(transform: NodeTransform) {
        this.type = (<TypeNodeTransform>transform).type;
    }
}

class SimpleAssignmentExpressionTransform implements TypeNodeTransform {

    _variables: Variable[];
    type: string | TypeResolvable = '';
    private _pushCount = 0;

    constructor(public kind: string, private varTypeOverrides: Tag[] | null) {
        this._variables = [];
    }

    push(transform: NodeTransform) {
        if (['=', '&'].includes(transform.kind)) {
            return;
        }
        ++this._pushCount;

        //ws and = should be excluded
        if (this._pushCount === 1) {
            this._lhs(transform);
        } else if (this._pushCount === 2) {
            this.type = (<TypeNodeTransform>transform).type || '';
        }

    }

    private _typeOverride(name: string, tags: Tag[] | null) {
        if (!tags) {
            return undefined;
        }
        let t: Tag;
        for (let n = 0; n < tags.length; ++n) {
            t = tags[n];
            if (name === t.name) {
                return t.typeString;
            }
        }
        return undefined;
    }

    private _lhs(lhs: NodeTransform) {
        switch (lhs.kind) {
            case 'variable_name':
                {
                    let ref = (<SimpleVariableTransform>lhs).reference;
                    if (ref) {
                        this._variables.push(Variable.create(ref.name, ref.type || ''));
                    }
                    break;
                }
            case 'subscript_expression':
                {
                    let variable = (<SubscriptExpressionTransform>lhs).variable;
                    if (variable) {
                        this._variables.push(variable);
                    }
                    break;
                }
            case 'list_literal':
                this._variables = (<ListIntrinsicTransform>lhs).variables;
                break;
            default:
                break;
        }
    }

    get variables(): Variable[] {
        let tags = this.varTypeOverrides;
        let typeOverrideFn = this._typeOverride;

        let fn = (x: Variable) => {
            return Variable.create(
                x.name,
                async () => {
                    let type = await TypeString.resolve(this.type);
                    return Variable.resolveBaseVariable(x, typeOverrideFn(x.name, tags) || type);
                }
            );
        };
        return this._variables.map(fn);
    }

}

class ListIntrinsicTransform implements NodeTransform {

    kind = 'list_literal';
    variables: Variable[];

    constructor() {
        this.variables = [];
    }

    push(transform: NodeTransform) {

        if (transform.kind !== 'array_creation_expression') {
            return;
        }

        this.variables = (<ArrayInititialiserListTransform>transform).variables;
        for (let n = 0; n < this.variables.length; ++n) {
            this.variables[n].arrayDereferenced--;
        }
    }

}

class ArrayInititialiserListTransform implements TypeNodeTransform {

    kind = 'array_creation_expression';
    variables: Variable[];
    private _types: (string | TypeResolvable)[];

    constructor() {
        this.variables = [];
        this._types = [];
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'array_element_initializer') {
            Array.prototype.push.apply(this.variables, (<ArrayValueTransform>transform).variables);
            this._types.push((<ArrayValueTransform>transform).type);
        }
    }

    get type(): TypeResolvable {
        return async () => {
            let merged: string;
            let types: (string | TypeResolvable)[];
            if (this._types.length < 4) {
                types = this._types;
            } else {
                types = [this._types[0], this._types[Math.floor(this._types.length / 2)], this._types[this._types.length - 1]];
            }
            merged = TypeString.mergeMany(await TypeString.resolveArray(types));
            return TypeString.count(merged) < 3 && merged.indexOf('mixed') < 0 ? merged : 'mixed';
        };
    }

}

class ArrayValueTransform implements TypeNodeTransform {

    kind = 'array_element_initializer';
    variables: Variable[];
    type: string | TypeResolvable = '';

    constructor() {
        this.variables = [];
    }

    push(transform: NodeTransform) {
        switch (transform.kind) {
            case 'simple_name':
                {
                    let ref = (<SimpleVariableTransform>transform).reference;
                    this.variables = [{ name: ref.name, arrayDereferenced: 0, type: ref.type || '' }];
                    this.type = ref.type || '';
                }
                break;

            case 'subscript_expression':
                {
                    let v = (<SubscriptExpressionTransform>transform).variable
                    if (v) {
                        this.variables = [v];
                    }
                    this.type = (<SubscriptExpressionTransform>transform).type;
                }
                break;

            case 'list_literal':
                this.variables = (<ListIntrinsicTransform>transform).variables;
                break;

            case '&':
                this.type = (<TypeNodeTransform>transform).type;
                break;
        }
    }

}

class CoalesceExpressionTransform implements TypeNodeTransform {

    kind = '??';
    type: string | TypeResolvable = '';

    push(transform: NodeTransform) {
        this.type = async () => {
            return TypeString.merge(
                await TypeString.resolve(this.type),
                await TypeString.resolve((<TypeNodeTransform>transform).type)
            );
        };
    }

}

class TernaryExpressionTransform implements TypeNodeTransform {

    kind = 'conditional_expression';
    private _transforms: NodeTransform[];

    constructor() {
        this._transforms = [];
    }

    push(transform: NodeTransform) {
        this._transforms.push(transform);
    }

    get type() {
        return async () => {
            let result = '';

            const transforms = this._transforms.slice(-2);
            for (const transform of transforms) {
                const transformType = await TypeString.resolve((<TypeNodeTransform>transform).type);

                result = TypeString.merge(result, transformType);
            }

            return result;
        };
    }

}

class SubscriptExpressionTransform implements TypeNodeTransform, VariableNodeTransform {

    kind = 'subscript_expression';
    variable: Variable;
    type: string | TypeResolvable = '';
    private _pushCount = 0;

    push(transform: NodeTransform) {

        if (this._pushCount > 0) {
            return;
        }

        ++this._pushCount;

        switch (transform.kind) {
            case 'simple_name':
                {
                    let ref = (<SimpleVariableTransform>transform).reference;
                    if (ref) {
                        this.type = async () => {
                            return TypeString.arrayDereference(await TypeString.resolve(ref.type || ''));
                        };
                        this.variable = { name: ref.name, arrayDereferenced: 1, type: this.type };
                    }
                }
                break;

            case 'subscript_expression':
                {
                    let v = (<SubscriptExpressionTransform>transform).variable;
                    this.type = async () => {
                        const type = await TypeString.resolve((<SubscriptExpressionTransform>transform).type);

                        return TypeString.arrayDereference(type);
                    };

                    if (v) {
                        v.arrayDereferenced++;
                        this.variable = v;
                        this.variable.type = this.type;
                    }
                }
                break;

            case 'function_call_expression':
            case 'scoped_property_access_expression':
            case 'scoped_call_expression':
            case 'member_call_expression':
            case 'array_creation_expression':
                this.type = async () => {
                    return TypeString.arrayDereference(await TypeString.resolve((<TypeNodeTransform>transform).type));
                };
                break;

            default:
                break;
        }
    }

}

class InstanceOfExpressionTransform implements TypeNodeTransform, VariableNodeTransform {

    kind = 'instanceof';
    type = 'bool';
    private _pushCount = 0;
    private _varName = '';
    private _varType: string | TypeResolvable;

    push(transform: NodeTransform) {

        ++this._pushCount;
        if (this._pushCount === 1) {
            if (transform.kind === 'variable_name') {
                let ref = (<SimpleVariableTransform>transform).reference;
                if (ref) {
                    this._varName = ref.name;
                }
            }
        } else if (transform.kind === 'qualified_name') {
            this._varType = async () => {
                return TypeString.resolve((<TypeDesignatorTransform>transform).type);
            };
        }

    }

    get variable() {
        return this._varName && this._varType ? {
            name: this._varName, arrayDereferenced: 0, type: this._varType
        } : Variable.create('', '');
    }

}

class FunctionCallExpressionTransform implements TypeNodeTransform {

    kind = 'function_call_expression';
    type: string | TypeResolvable = '';

    constructor(public referenceSymbolDelegate: ReferenceSymbolDelegate) { }

    push(transform: NodeTransform) {
        switch (transform.kind) {
            case 'qualified_name':
                {
                    let ref = (<ReferenceNodeTransform>transform).reference;
                    this.type = async () => {
                        return (await this.referenceSymbolDelegate(ref))
                            .reduce(symbolsToTypeReduceFn, '');
                    };
                    break;
                }

            default:
                break;
        }
    }

}

class RelativeScopeTransform implements TypeNodeTransform, ReferenceNodeTransform {

    private static readonly ALLOWED_KINDS = new Set([
        'static', 'self',
    ]);
    kind = 'relative_scope';
    reference: Reference;
    constructor(public type: string, loc: lsp.Location) {
        this.reference = Reference.create(SymbolKind.Class, type, loc);
        this.reference.altName = 'static';
    }
    push(transform: NodeTransform) {
        if (RelativeScopeTransform.ALLOWED_KINDS.has(transform.kind)) {
            this.reference.altName = transform.kind;
        }
    }
}

class TypeDesignatorTransform implements TypeNodeTransform {

    type: string | TypeResolvable = '';

    constructor(public kind: string) { }

    push(transform: NodeTransform) {
        switch (transform.kind) {
            case 'relative_scope':
            case 'qualified_name':
                this.type = (<TypeNodeTransform>transform).type;
                break;

            default:
                break;
        }
    }

}

class ObjectCreationExpressionTransform implements TypeNodeTransform {

    kind = 'object_creation_expression';
    type: string | TypeResolvable = '';

    push(transform: NodeTransform) {
        if (transform.kind === '_class_type_designator') {
            this.type = (<TypeNodeTransform>transform).type;
        }
    }

}

class SimpleVariableTransform implements TypeNodeTransform, ReferenceNodeTransform {

    kind = 'variable_name';
    reference: Reference;
    private _varTable: VariableTable;

    constructor(loc: lsp.Location, varTable: VariableTable) {
        this._varTable = varTable;
        this.reference = Reference.create(SymbolKind.Variable, '', loc);
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'name') {
            this.reference.name = '$' + (<TokenTransform>transform).text;
            this.reference.type = this._varTable.getType(this.reference.name);
        }
    }

    get type() {
        return this.reference.type || '';
    }

}

class DereferencableExpression implements TypeNodeTransform {

    kind = 'dereferencable_expression';
    type: TypeResolvable | string = '';

    push(transform: NodeTransform) {
        if (transform.kind === 'variable_name') {
            this.type = (<TypeNodeTransform>transform).type;
        }
    }

}

class GlobalVariableTransform implements TypeNodeTransform, ReferenceNodeTransform {

    kind = 'variable_name';
    reference: Reference;

    constructor(loc: lsp.Location, private varTable: VariableTable) {
        this.reference = Reference.create(SymbolKind.GlobalVariable, '', loc);
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'name') {
            this.reference.name = '$' + (<TokenTransform>transform).text;

            let topLevelScope = this.varTable.getScope(0);

            this.reference.type = this.reference.name in topLevelScope.variables ?
                topLevelScope.variables[this.reference.name].type : '';
        }
    }

    get type() {
        return this.reference.type || '';
    }

}

class QualifiedNameTransform implements TypeNodeTransform, ReferenceNodeTransform {

    kind = 'qualified_name';
    reference: Reference;
    private _namespacePrefix = '';
    private _nameResolver: NameResolver;

    constructor(symbolKind: SymbolKind, loc: lsp.Location, nameResolver: NameResolver) {
        this.reference = Reference.create(symbolKind, '', loc);
        this._nameResolver = nameResolver;
    }

    push(transform: NodeTransform) {

        if (transform.kind === 'name') {
            const name = (<NamespaceNameTransform>transform).text;
            const lcName = name.toLowerCase();
            if (this._namespacePrefix.length) {
                this.reference.name = this._namespacePrefix + '\\' + name;
            } else {
                this.reference.name = this._nameResolver.resolveNotFullyQualified(name, this.reference.kind);
                if (
                    ((this.reference.kind === SymbolKind.Function || this.reference.kind === SymbolKind.Constant) &&
                        name !== this.reference.name && name.indexOf('\\') < 0) || (lcName === 'parent' || lcName === 'self')
                ) {
                    this.reference.altName = name;
                }
            }
        } else if (transform.kind === 'namespace_name_as_prefix') {
            this._namespacePrefix = (<NamespaceNameAsPrefixTransform>transform).text;
        }

    }

    get type() {
        return this.reference.name;
    }

}

class MemberNameTransform implements ReferenceNodeTransform {

    kind = 'member_name';
    reference: Reference;

    constructor(node: SyntaxNode, loc: lsp.Location) {
        this.reference = Reference.create(SymbolKind.None, node.text, loc);
    }

    push(transform: NodeTransform) {
    }

}

class MemberAccessExpressionTransform implements TypeNodeTransform, ReferenceNodeTransform {

    reference: Reference;
    private _scope: string | TypeResolvable = '';

    constructor(
        public kind: string,
        public symbolKind: SymbolKind,
        public referenceSymbolDelegate: ReferenceSymbolDelegate
    ) { }

    push(transform: NodeTransform) {

        switch (transform.kind) {
            case 'member_name':
            case 'variable_name':
                this.reference = (<ReferenceNodeTransform>transform).reference;
                this.reference.kind = this.symbolKind;
                this.reference.scope = this._scope;
                if (this.symbolKind === SymbolKind.Property && this.reference.name && this.reference.name[0] !== '$') {
                    this.reference.name = '$' + this.reference.name;
                }
                break;

            case 'scoped_call_expression':
            case 'scoped_property_access_expression':
            case 'function_call_expression':
            case 'subscript_expression':
            case 'qualified_name':
            case 'relative_scope':
            case 'dereferencable_expression':
                this._scope = async () => {
                    return await TypeString.resolve((<TypeNodeTransform>transform).type);
                };
                break;

            default:
                break;
        }

    }

    get type(): TypeResolvable {
        return async () => {
            return (await this.referenceSymbolDelegate(this.reference))
                .reduce(symbolsToTypeReduceFn, '');
        };
    }

}

class NamespaceDefinitionTransform implements ReferenceNodeTransform {

    kind = 'namespace_definition';
    reference: Reference;

    push(transform: NodeTransform) {
        if (transform.kind === 'namespace_name') {
            this.reference = Reference.create(
                SymbolKind.Namespace,
                (<NamespaceNameTransform>transform).text,
                (<NamespaceNameTransform>transform).location
            );
        }
    }

}

class ParameterDeclarationTransform implements ReferenceNodeTransform {

    kind = 'simple_parameter';
    reference: Reference;

    push(transform: NodeTransform) {
        if (transform.kind === 'variable_name') {
            this.reference = Reference.create(
                SymbolKind.Parameter,
                (<SimpleVariableTransform>transform).reference.name,
                (<SimpleVariableTransform>transform).reference.location
            );
        }
    }

}

export class VariableTable {

    private _typeVariableSetStack: VariableSet[];

    constructor() {
        this._typeVariableSetStack = [VariableSet.create(VariableSetKind.Scope)];
    }

    setVariable(v: Variable) {
        this._typeVariableSetStack[this._typeVariableSetStack.length - 1].variables[v.name] = v;
    }

    setVariables(vars: Variable[]) {
        if (!vars) {
            return;
        }
        for (let n = 0; n < vars.length; ++n) {
            this.setVariable(vars[n]);
        }
    }

    pushScope(carry?: string[]) {

        let scope = VariableSet.create(VariableSetKind.Scope);

        if (carry) {
            let type: string | TypeResolvable;
            let name: string
            for (let n = 0; n < carry.length; ++n) {
                name = carry[n];
                type = this.getType(name);
                if (type && name) {
                    scope.variables[name] = Variable.create(name, type);
                }
            }
        }

        this._typeVariableSetStack.push(scope);

    }

    popScope() {
        this._typeVariableSetStack.pop();
    }

    pushBranch() {
        let b = VariableSet.create(VariableSetKind.Branch);
        this._typeVariableSetStack[this._typeVariableSetStack.length - 1].branches.push(b);
        this._typeVariableSetStack.push(b);
    }

    popBranch() {
        this._typeVariableSetStack.pop();
    }

    /**
     * consolidates variables. 
     * each variable can be any of types discovered in branches after this.
     */
    pruneBranches() {

        let node = this._typeVariableSetStack[this._typeVariableSetStack.length - 1];
        let branches = node.branches;
        node.branches = [];
        for (let n = 0, l = branches.length; n < l; ++n) {
            this._mergeSets(node, branches[n]);
        }

    }

    getType(varName: string) {

        let typeSet: VariableSet;

        for (let n = this._typeVariableSetStack.length - 1; n >= 0; --n) {
            typeSet = this._typeVariableSetStack[n];

            if (typeSet.variables[varName]) {
                return typeSet.variables[varName].type;
            }

            if (typeSet.kind === VariableSetKind.Scope) {
                break;
            }
        }

        return '';

    }

    getScope(level: number) {
        return this._typeVariableSetStack[level];
    }

    private _mergeSets(a: VariableSet, b: VariableSet) {

        let keys = Object.keys(b.variables);
        let bVariable: Variable;
        for (let n = 0, l = keys.length; n < l; ++n) {
            bVariable = b.variables[keys[n]];
            if (a.variables[bVariable.name]) {
                const aType = a.variables[bVariable.name].type;
                const bType = bVariable.type;

                a.variables[bVariable.name].type = async () => {
                    return TypeString.merge(
                        await TypeString.resolve(aType),
                        await TypeString.resolve(bType)
                    );
                };
            } else {
                a.variables[bVariable.name] = bVariable;
            }
        }

    }

}

const enum VariableSetKind {
    None, Scope, BranchGroup, Branch
}

interface VariableSet {
    kind: VariableSetKind;
    variables: { [index: string]: Variable };
    branches: VariableSet[];
}

namespace VariableSet {
    export function create(kind: VariableSetKind) {
        return <VariableSet>{
            kind: kind,
            variables: {},
            branches: []
        };
    }
}

export namespace ReferenceReader {
    export async function discoverReferences(
        doc: ParsedDocument, symbolStore: SymbolStore, symbolTable?: SymbolTable
    ) {
        if (!symbolTable) {
            symbolTable = await symbolStore.getSymbolTable(doc.uri);
        }
        let symbols: PhpSymbol[] = [];
        if (symbolTable) {
            const traverser = new TreeTraverser([symbolTable.root]);
            symbols = traverser.filter((s: PhpSymbol) => {
                return SymbolIndex.isNamedSymbol(s);
            });
        }

        const globalVariables = await symbolStore.getGlobalVariables();
        const visitor = new ReferenceReader(doc, new NameResolver(), symbolStore, symbols, globalVariables);
        doc.traverse(visitor);
        return visitor.refTable;
    }
}