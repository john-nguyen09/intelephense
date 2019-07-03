/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import {
    TreeVisitor, TreeTraverser
} from './types';
import { SymbolKind, PhpSymbol, SymbolModifier } from './symbol';
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
    private _lastVarTypehints: Tag[];
    private _symbolOffset = 0;

    constructor(
        public doc: ParsedDocument,
        public nameResolver: NameResolver,
        public symbolStore: SymbolStore,
        namedSymbols: PhpSymbol[],
        globalVariables: PhpSymbol[]
    ) {
        this._transformStack = [];
        this._variableTable = new VariableTable();
        this._classStack = [];
        this._symbols = namedSymbols;

        const fileSymbol = this.shiftSymbol();
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

    private shiftSymbol() {
        if (this._symbolOffset >= this._symbols.length) {
            throw new Error('CodingError: symbol tree is not in sync with ReferenceReader');
        }

        let result = this._symbols[this._symbolOffset++];

        return result;
    }

    private currentSymbol() {
        if (this._symbolOffset >= this._symbols.length) {
            return undefined;
        }

        return this._symbols[this._symbolOffset];
    }

    private symbolsLength() {
        return this._symbols.length - this._symbolOffset;
    }

    preorder(node: SyntaxNode, spine: SyntaxNode[]) {

        const parent = spine.length ? spine[spine.length - 1] : null;
        const parentTransform = this._transformStack.length ?
            this._transformStack[this._transformStack.length - 1] : null;

        switch (node.type) {

            case 'ERROR':
                this._transformStack.push(null);

            case 'namespace_definition':
                {
                    const s = this.shiftSymbol();
                    this._scopeStackPush(Scope.create(this.doc.nodeLocation(node)));
                    this.nameResolver.namespace = s;
                    this._transformStack.push(new NamespaceDefinitionTransform());
                }
                break;

            case 'class_declaration':
                this._transformStack.push(new HeaderTransform(this.nameResolver, SymbolKind.Class));
                break;

            case 'interface_declaration':
                this._transformStack.push(new HeaderTransform(this.nameResolver, SymbolKind.Interface));
                break;

            case 'trait_declaration':
                this._transformStack.push(new HeaderTransform(this.nameResolver, SymbolKind.Trait));
                break;

            case 'function_declaration':
                this._transformStack.push(new HeaderTransform(this.nameResolver, SymbolKind.Function));
                break;

            case 'function_call_expression':
                if (parentTransform) {
                    this._transformStack.push(new FunctionCallExpressionTransform(this._referenceSymbols));
                } else {
                    this._transformStack.push(null);
                }
                break;

            case 'const_element':
                this._transformStack.push(new HeaderTransform(this.nameResolver, SymbolKind.Constant));
                break;

            case PhraseKind.ClassConstElement:
                this._transformStack.push(new MemberDeclarationTransform(SymbolKind.ClassConstant, this._currentClassName()));
                this.shiftSymbol();
                break;

            case PhraseKind.MethodDeclarationHeader:
                this._transformStack.push(new MemberDeclarationTransform(SymbolKind.Method, this._currentClassName()));
                break;

            case PhraseKind.PropertyElement:
                this._transformStack.push(new PropertyElementTransform(this._currentClassName()));
                break;

            case PhraseKind.ParameterDeclaration:
                this._transformStack.push(new ParameterDeclarationTransform());
                break;

            case PhraseKind.NamespaceUseDeclaration:
                this._transformStack.push(new NamespaceUseDeclarationTransform());
                break;

            case PhraseKind.NamespaceUseGroupClauseList:
            case PhraseKind.NamespaceUseClauseList:
                this._transformStack.push(new NamespaceUseClauseListTransform(node.kind));
                break;

            case PhraseKind.NamespaceUseClause:
            case PhraseKind.NamespaceUseGroupClause:
                {
                    if(this.symbolsLength() && (this.currentSymbol().modifiers & SymbolModifier.Use) > 0) {
                        this.nameResolver.rules.push(this.shiftSymbol());
                    }
                    this._transformStack.push(new NamespaceUseClauseTransform(node.kind));
                    break;
                }

            case PhraseKind.FunctionDeclaration:
                this._transformStack.push(null);
                this._functionDeclaration(<Phrase>node);
                break;

            case PhraseKind.MethodDeclaration:
                this._transformStack.push(null);
                this._methodDeclaration(<Phrase>node);
                break;

            case PhraseKind.ClassDeclaration:
            case PhraseKind.TraitDeclaration:
            case PhraseKind.InterfaceDeclaration:
            case PhraseKind.AnonymousClassDeclaration:
                {
                    let s = this.shiftSymbol() || PhpSymbol.create(SymbolKind.Class, '', this.doc.nodeLocation(<Phrase>node));
                    this._scopeStackPush(Scope.create(this.doc.nodeLocation(<Phrase>node)));
                    this.nameResolver.pushClass(s);
                    this._classStack.push(s);
                    this._variableTable.pushScope();
                    this._variableTable.setVariable(Variable.create('$this', s.name));
                    this._transformStack.push(null);
                }
                break;

            case PhraseKind.AnonymousFunctionCreationExpression:
                this._anonymousFunctionCreationExpression(<Phrase>node);
                this._transformStack.push(null);
                break;

            case PhraseKind.IfStatement:
            case PhraseKind.SwitchStatement:
                this._transformStack.push(null);
                this._variableTable.pushBranch();
                break;

            case PhraseKind.CaseStatement:
            case PhraseKind.DefaultStatement:
            case PhraseKind.ElseIfClause:
            case PhraseKind.ElseClause:
                this._transformStack.push(null);
                this._variableTable.popBranch();
                this._variableTable.pushBranch();
                break;

            case PhraseKind.SimpleAssignmentExpression:
            case PhraseKind.ByRefAssignmentExpression:
                this._transformStack.push(new SimpleAssignmentExpressionTransform(node.kind, this._lastVarTypehints));
                break;

            case PhraseKind.InstanceOfExpression:
                this._transformStack.push(new InstanceOfExpressionTransform());
                break;

            case PhraseKind.ForeachStatement:
                this._transformStack.push(new ForeachStatementTransform());
                break;

            case PhraseKind.ForeachCollection:
                this._transformStack.push(new ForeachCollectionTransform());
                break;

            case PhraseKind.ForeachValue:
                this._transformStack.push(new ForeachValueTransform());
                break;

            case PhraseKind.CatchClause:
                this._transformStack.push(new CatchClauseTransform());
                break;

            case PhraseKind.CatchNameList:
                this._transformStack.push(new CatchNameListTransform());
                break;

            case PhraseKind.QualifiedName:
                if (
                    parent &&
                    parent.kind === PhraseKind.FunctionCallExpression &&
                    this.doc.nodeText(node).toLowerCase() === 'define'
                ) {
                    this.shiftSymbol();
                }

                this._transformStack.push(
                    new QualifiedNameTransform(this._nameSymbolType(<Phrase>parent), this.doc.nodeLocation(node), this.nameResolver)
                );
                break;

            case PhraseKind.FullyQualifiedName:
                this._transformStack.push(
                    new FullyQualifiedNameTransform(this._nameSymbolType(<Phrase>parent), this.doc.nodeLocation(node))
                );
                break;

            case PhraseKind.RelativeQualifiedName:
                this._transformStack.push(
                    new RelativeQualifiedNameTransform(this._nameSymbolType(<Phrase>parent), this.doc.nodeLocation(node), this.nameResolver)
                );
                break;

            case PhraseKind.NamespaceName:
                this._transformStack.push(new NamespaceNameTransform(<Phrase>node, this.doc));
                break;

            case PhraseKind.SimpleVariable:
                let isGlobal = false;

                for (let i = spine.length - 1; i >= 0; i--) {
                    if ((<Phrase>spine[i]).kind == PhraseKind.GlobalDeclaration) {
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

            case PhraseKind.ListIntrinsic:
                this._transformStack.push(new ListIntrinsicTransform());
                break;

            case PhraseKind.ArrayInitialiserList:
                if (parentTransform) {
                    this._transformStack.push(new ArrayInititialiserListTransform());
                } else {
                    this._transformStack.push(null);
                }
                break;

            case PhraseKind.ArrayElement:
                if (parentTransform) {
                    this._transformStack.push(new ArrayElementTransform());
                } else {
                    this._transformStack.push(null);
                }
                break;

            case PhraseKind.ArrayValue:
                if (parentTransform) {
                    this._transformStack.push(new ArrayValueTransform());
                } else {
                    this._transformStack.push(null);
                }
                break;

            case PhraseKind.SubscriptExpression:
                if (parentTransform) {
                    this._transformStack.push(new SubscriptExpressionTransform());
                } else {
                    this._transformStack.push(null);
                }
                break;

            case PhraseKind.ScopedCallExpression:
                this._transformStack.push(
                    new MemberAccessExpressionTransform(PhraseKind.ScopedCallExpression, SymbolKind.Method, this._referenceSymbols)
                );
                break;

            case PhraseKind.ScopedPropertyAccessExpression:
                this._transformStack.push(
                    new MemberAccessExpressionTransform(PhraseKind.ScopedPropertyAccessExpression, SymbolKind.Property, this._referenceSymbols)
                );
                break;

            case PhraseKind.ClassConstantAccessExpression:
                this._transformStack.push(
                    new MemberAccessExpressionTransform(PhraseKind.ClassConstantAccessExpression, SymbolKind.ClassConstant, this._referenceSymbols)
                );
                break;

            case PhraseKind.ScopedMemberName:
                this._transformStack.push(new ScopedMemberNameTransform(this.doc.nodeLocation(node)));
                break;

            case PhraseKind.Identifier:
                if (parentTransform) {
                    this._transformStack.push(new IdentifierTransform());
                } else {
                    this._transformStack.push(null);
                }
                break;

            case PhraseKind.PropertyAccessExpression:
                this._transformStack.push(
                    new MemberAccessExpressionTransform(PhraseKind.PropertyAccessExpression, SymbolKind.Property, this._referenceSymbols)
                );
                break;

            case PhraseKind.MethodCallExpression:
                this._transformStack.push(
                    new MemberAccessExpressionTransform(PhraseKind.MethodCallExpression, SymbolKind.Method, this._referenceSymbols)
                );
                break;

            case PhraseKind.MemberName:
                this._transformStack.push(new MemberNameTransform(this.doc.nodeLocation(node)));
                break;

            case PhraseKind.AnonymousFunctionUseVariable:
                this._transformStack.push(new AnonymousFunctionUseVariableTransform());
                break;

            case PhraseKind.ObjectCreationExpression:
                if (parentTransform) {
                    this._transformStack.push(new ObjectCreationExpressionTransform());
                } else {
                    this._transformStack.push(null);
                }
                break;

            case PhraseKind.ClassTypeDesignator:
            case PhraseKind.InstanceofTypeDesignator:
                if (parentTransform) {
                    this._transformStack.push(new TypeDesignatorTransform(node.kind));
                } else {
                    this._transformStack.push(null);
                }
                break;

            case PhraseKind.RelativeScope:
                let context = this._classStack.length ? this._classStack[this._classStack.length - 1] : null;
                let name = context ? context.name : '';
                this._transformStack.push(new RelativeScopeTransform(name, this.doc.nodeLocation(node)));
                break;

            case PhraseKind.TernaryExpression:
                if (parentTransform) {
                    this._transformStack.push(new TernaryExpressionTransform());
                } else {
                    this._transformStack.push(null);
                }
                break;

            case PhraseKind.CoalesceExpression:
                if (parentTransform) {
                    this._transformStack.push(new CoalesceExpressionTransform());
                } else {
                    this._transformStack.push(null);
                }
                break;

            case PhraseKind.EncapsulatedExpression:
                if (parentTransform) {
                    this._transformStack.push(new EncapsulatedExpressionTransform());
                } else {
                    this._transformStack.push(null);
                }
                break;

            default:
                this._transformStack.push(null);
                break;
        }
        
        if (parentTransform && node.kind > TokenKind.EndOfFile && (<Token>node).kind < TokenKind.Equals) {
            parentTransform.push(new TokenTransform(<Token>node, this.doc));
            if (parentTransform.phraseKind === PhraseKind.CatchClause && (<Token>node).kind === TokenKind.VariableName) {
                this._variableTable.setVariable((<CatchClauseTransform>parentTransform).variable);
            }
        } else if ((<Token>node).kind === TokenKind.DocumentComment) {
            let phpDoc = PhpDocParser.parse(this.doc.tokenText(<Token>node));
            if (phpDoc) {
                this._lastVarTypehints = phpDoc.varTags;
                let varTag: Tag;
                for (let n = 0, l = this._lastVarTypehints.length; n < l; ++n) {
                    varTag = this._lastVarTypehints[n];
                    varTag.typeString = TypeString.nameResolve(varTag.typeString, this.nameResolver);
                    this._variableTable.setVariable(Variable.create(varTag.name, varTag.typeString));
                }
            }
        } else if ((<Token>node).kind === TokenKind.OpenBrace || (<Token>node).kind === TokenKind.CloseBrace || node.kind === TokenKind.Semicolon) {
            this._lastVarTypehints = undefined;
        }

        return true;

    }

    postorder(node: Phrase | Token, spine: (Phrase | Token)[]) {

        if (!ParsedDocument.isPhrase(node)) {
            return;
        }

        let transform = this._transformStack.pop();
        let parentTransform = this._transformStack.length ? this._transformStack[this._transformStack.length - 1] : null;
        let scope = this._scopeStack.length ? this._scopeStack[this._scopeStack.length - 1] : null;

        if (parentTransform && transform) {
            parentTransform.push(transform);
        }

        switch (node.kind) {

            case PhraseKind.FullyQualifiedName:
            case PhraseKind.QualifiedName:
            case PhraseKind.RelativeQualifiedName:
            case PhraseKind.SimpleVariable:
            case PhraseKind.ScopedCallExpression:
            case PhraseKind.ClassConstantAccessExpression:
            case PhraseKind.ScopedPropertyAccessExpression:
            case PhraseKind.PropertyAccessExpression:
            case PhraseKind.MethodCallExpression:
            case PhraseKind.NamespaceUseClause:
            case PhraseKind.NamespaceUseGroupClause:
            case PhraseKind.ClassDeclarationHeader:
            case PhraseKind.InterfaceDeclarationHeader:
            case PhraseKind.TraitDeclarationHeader:
            case PhraseKind.FunctionDeclarationHeader:
            case PhraseKind.ConstElement:
            case PhraseKind.PropertyElement:
            case PhraseKind.ClassConstElement:
            case PhraseKind.MethodDeclarationHeader:
            case PhraseKind.NamespaceDefinition:
            case PhraseKind.ParameterDeclaration:
            case PhraseKind.AnonymousFunctionUseVariable:
            case PhraseKind.RelativeScope:
                if (scope && transform) {
                    let ref = (<ReferenceNodeTransform>transform).reference;

                    if (transform instanceof GlobalVariableTransform) {
                        this._variableTable.setVariable(Variable.create(ref.name, ref.type));
                    }

                    if (ref) {
                        scope.children.push(ref);
                    }
                }

                if (node.kind === PhraseKind.NamespaceDefinition) {
                    this._scopeStack.pop();
                }
                break;

            case PhraseKind.SimpleAssignmentExpression:
            case PhraseKind.ByRefAssignmentExpression:
                this._variableTable.setVariables((<SimpleAssignmentExpressionTransform>transform).variables);
                break;

            case PhraseKind.InstanceOfExpression:
                this._variableTable.setVariable((<InstanceOfExpressionTransform>transform).variable);
                break;

            case PhraseKind.ForeachValue:
                this._variableTable.setVariables((<ForeachStatementTransform>parentTransform).variables);
                break;

            case PhraseKind.IfStatement:
            case PhraseKind.SwitchStatement:
                this._variableTable.popBranch();
                this._variableTable.pruneBranches();
                break;

            case PhraseKind.ClassDeclaration:
            case PhraseKind.TraitDeclaration:
            case PhraseKind.InterfaceDeclaration:
            case PhraseKind.AnonymousClassDeclaration:
                this.nameResolver.popClass();
                this._classStack.pop();
                this._scopeStack.pop();
                this._variableTable.popScope();
                break;

            case PhraseKind.FunctionDeclaration:
            case PhraseKind.MethodDeclaration:
            case PhraseKind.AnonymousFunctionCreationExpression:
                this._scopeStack.pop();
                this._variableTable.popScope();
                break;

            default:
                break;
        }

    }

    private _currentClassName() {
        let c = this._classStack.length ? this._classStack[this._classStack.length - 1] : undefined;
        return c ? c.name : '';
    }

    private _scopeStackPush(scope: Scope) {
        if (this._scopeStack.length) {
            this._scopeStack[this._scopeStack.length - 1].children.push(scope);
        }
        this._scopeStack.push(scope);
    }

    private _nameSymbolType(parent: Phrase) {
        if (!parent) {
            return SymbolKind.Class;
        }

        switch (parent.kind) {
            case PhraseKind.ConstantAccessExpression:
                return SymbolKind.Constant;
            case PhraseKind.FunctionCallExpression:
                return SymbolKind.Function;
            case PhraseKind.ClassTypeDesignator:
                return SymbolKind.Constructor;
            default:
                return SymbolKind.Class;
        }
    }

    private _methodDeclaration(node: Phrase) {

        let scope = Scope.create(this.doc.nodeLocation(node));
        this._scopeStackPush(scope);
        this._variableTable.pushScope(['$this']);
        let symbol = this.shiftSymbol();

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

    private _functionDeclaration(node: Phrase) {
        let symbol = this.shiftSymbol();
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

    private _anonymousFunctionCreationExpression(node: Phrase) {
        let symbol = this.shiftSymbol();
        this._scopeStackPush(Scope.create(this.doc.nodeLocation(node)));
        let carry: string[] = ['$this'];
        let children = symbol && symbol.children ? symbol.children : [];
        let s: PhpSymbol;

        for (let n = 0, l = children.length; n < l; ++n) {
            s = children[n];
            if (s.kind === SymbolKind.Variable && (s.modifiers & SymbolModifier.Use) > 0) {
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

    constructor(public token: Token, public doc: ParsedDocument) { }

    get tokenKind() {
        return this.token.kind;
    }

    get text() {
        return this.doc.tokenText(this.token);
    }

    get location() {
        return this.doc.nodeLocation(this.token);
    }

    get type() {
        switch (this.tokenKind) {
            case TokenKind.FloatingLiteral:
                return 'float';
            case TokenKind.StringLiteral:
            case TokenKind.EncapsulatedAndWhitespace:
                return 'string';
            case TokenKind.IntegerLiteral:
                return 'int';
            case TokenKind.Name:
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

    phraseKind = PhraseKind.NamespaceName;
    private _parts: string[];

    constructor(public node: Phrase, public document: ParsedDocument) {
        this._parts = [];
    }

    get location() {
        return this.document.nodeLocation(this.node);
    }

    push(transform: NodeTransform) {
        if (transform.tokenKind === TokenKind.Name) {
            this._parts.push((<TokenTransform>transform).text);
        }
    }

    get text() {
        return this._parts.join('\\');
    }

}

class NamespaceUseClauseListTransform implements NodeTransform {

    references: Reference[];

    constructor(public phraseKind: PhraseKind) {
        this.references = [];
    }

    push(transform: NodeTransform) {
        if (
            transform.phraseKind === PhraseKind.NamespaceUseClause ||
            transform.phraseKind === PhraseKind.NamespaceUseGroupClause
        ) {
            this.references.push((<ReferenceNodeTransform>transform).reference);
        }
    }

}

class NamespaceUseDeclarationTransform implements NodeTransform {

    phraseKind = PhraseKind.NamespaceUseDeclaration;
    references: Reference[];
    private _kind = SymbolKind.Class;
    private _prefix = '';

    constructor() {
        this.references = [];
    }

    push(transform: NodeTransform) {
        if (transform.tokenKind === TokenKind.Const) {
            this._kind = SymbolKind.Constant;
        } else if (transform.tokenKind === TokenKind.Function) {
            this._kind = SymbolKind.Function;
        } else if (transform.phraseKind === PhraseKind.NamespaceName) {
            this._prefix = (<NamespaceNameTransform>transform).text;
        } else if (transform.phraseKind === PhraseKind.NamespaceUseGroupClauseList) {
            this.references = (<NamespaceUseClauseListTransform>transform).references;
            let ref: Reference;
            let prefix = this._prefix ? this._prefix + '\\' : '';
            for (let n = 0; n < this.references.length; ++n) {
                ref = this.references[n];
                ref.name = prefix + ref.name;
                if (!ref.kind) {
                    ref.kind = this._kind;
                }
            }
        } else if (transform.phraseKind === PhraseKind.NamespaceUseClauseList) {
            this.references = (<NamespaceUseClauseListTransform>transform).references;
            let ref: Reference;
            for (let n = 0; n < this.references.length; ++n) {
                ref = this.references[n];
                ref.kind = this._kind;
            }
        }
    }

}

class NamespaceUseClauseTransform implements ReferenceNodeTransform {

    reference: Reference;

    constructor(public phraseKind: PhraseKind) {
        this.reference = Reference.create(0, '', null);
    }

    push(transform: NodeTransform) {
        if (transform.tokenKind === TokenKind.Function) {
            this.reference.kind = SymbolKind.Function;
        } else if (transform.tokenKind === TokenKind.Const) {
            this.reference.kind = SymbolKind.Constant;
        } else if (transform.phraseKind === PhraseKind.NamespaceName) {
            this.reference.name = (<NamespaceNameTransform>transform).text;
            this.reference.location = (<NamespaceNameTransform>transform).location;
        }
    }

}

type ReferenceSymbolDelegate = (ref: Reference) => Promise<PhpSymbol[]>;

class CatchClauseTransform implements VariableNodeTransform {

    phraseKind = PhraseKind.CatchClause;
    private _varType = '';
    private _varName = '';

    push(transform: NodeTransform) {
        if (transform.phraseKind === PhraseKind.CatchNameList) {
            this._varType = (<CatchNameListTransform>transform).type;
        } else if (transform.tokenKind === TokenKind.VariableName) {
            this._varName = (<TokenTransform>transform).text;
        }
    }

    get variable() {
        return this._varName && this._varType ? Variable.create(this._varName, this._varType) : null;
    }

}

class CatchNameListTransform implements TypeNodeTransform {

    phraseKind = PhraseKind.CatchNameList;
    type = '';

    push(transform: NodeTransform) {
        let ref = (<ReferenceNodeTransform>transform).reference;
        if (ref) {
            this.type = TypeString.merge(this.type, ref.name);
        }
    }

}

class AnonymousFunctionUseVariableTransform implements ReferenceNodeTransform {
    phraseKind = PhraseKind.AnonymousFunctionUseVariable;
    reference: Reference;

    push(transform: NodeTransform) {
        if (transform.tokenKind === TokenKind.VariableName) {
            this.reference = Reference.create(SymbolKind.Variable, (<TokenTransform>transform).text, (<TokenTransform>transform).location);
        }
    }
}

class ForeachStatementTransform implements NodeTransform {

    phraseKind = PhraseKind.ForeachStatement;
    variables: Variable[];
    private _type: string | TypeResolvable = '';

    constructor() {
        this.variables = [];
    }

    push(transform: NodeTransform) {
        if (transform.phraseKind === PhraseKind.ForeachCollection) {
            this._type = async (): Promise<string> => {
                let transformType = await TypeString.resolve((<ForeachCollectionTransform>transform).type);
                return TypeString.arrayDereference(transformType)
            };
        } else if (transform.phraseKind === PhraseKind.ForeachValue) {
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

    phraseKind = PhraseKind.ForeachValue;
    variables: Variable[];

    constructor() {
        this.variables = [];
    }

    push(transform: NodeTransform) {
        if (transform.phraseKind === PhraseKind.SimpleVariable) {
            let ref = (<SimpleVariableTransform>transform).reference;
            this.variables = [{ name: ref.name, arrayDereferenced: 0, type: ref.type }];
        } else if (transform.phraseKind === PhraseKind.ListIntrinsic) {
            this.variables = (<ListIntrinsicTransform>transform).variables;
        }
    }

}

class ForeachCollectionTransform implements TypeNodeTransform {

    phraseKind = PhraseKind.ForeachCollection;
    type: string | TypeResolvable = '';

    push(transform: NodeTransform) {
        this.type = (<TypeNodeTransform>transform).type;
    }
}

class SimpleAssignmentExpressionTransform implements TypeNodeTransform {

    _variables: Variable[];
    type: string | TypeResolvable = '';
    private _pushCount = 0;

    constructor(public phraseKind: PhraseKind, private varTypeOverrides: Tag[]) {
        this._variables = [];
    }

    push(transform: NodeTransform) {
        ++this._pushCount;

        //ws and = should be excluded
        if (this._pushCount === 1) {
            this._lhs(transform);
        } else if (this._pushCount === 2) {
            this.type = (<TypeNodeTransform>transform).type || '';
        }

    }

    private _typeOverride(name: string, tags: Tag[]) {
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
        switch (lhs.phraseKind) {
            case PhraseKind.SimpleVariable:
                {
                    let ref = (<SimpleVariableTransform>lhs).reference;
                    if (ref) {
                        this._variables.push(Variable.create(ref.name, ref.type));
                    }
                    break;
                }
            case PhraseKind.SubscriptExpression:
                {
                    let variable = (<SubscriptExpressionTransform>lhs).variable;
                    if (variable) {
                        this._variables.push(variable);
                    }
                    break;
                }
            case PhraseKind.ListIntrinsic:
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

    phraseKind = PhraseKind.ListIntrinsic;
    variables: Variable[];

    constructor() {
        this.variables = [];
    }

    push(transform: NodeTransform) {

        if (transform.phraseKind !== PhraseKind.ArrayInitialiserList) {
            return;
        }

        this.variables = (<ArrayInititialiserListTransform>transform).variables;
        for (let n = 0; n < this.variables.length; ++n) {
            this.variables[n].arrayDereferenced--;
        }
    }

}

class ArrayInititialiserListTransform implements TypeNodeTransform {

    phraseKind = PhraseKind.ArrayInitialiserList;
    variables: Variable[];
    private _types: (string | TypeResolvable)[];

    constructor() {
        this.variables = [];
        this._types = [];
    }

    push(transform: NodeTransform) {
        if (transform.phraseKind === PhraseKind.ArrayElement) {
            Array.prototype.push.apply(this.variables, (<ArrayElementTransform>transform).variables);
            this._types.push((<ArrayElementTransform>transform).type);
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

class ArrayElementTransform implements TypeNodeTransform {

    phraseKind = PhraseKind.ArrayElement;
    variables: Variable[];
    type: string | TypeResolvable = '';

    constructor() {
        this.variables = [];
    }

    push(transform: NodeTransform) {
        if (transform.phraseKind === PhraseKind.ArrayValue) {
            this.variables = (<ArrayValueTransform>transform).variables;
            this.type = (<ArrayValueTransform>transform).type;
        }
    }

}

class ArrayValueTransform implements TypeNodeTransform {

    phraseKind = PhraseKind.ArrayValue;
    variables: Variable[];
    type: string | TypeResolvable = '';

    constructor() {
        this.variables = [];
    }

    push(transform: NodeTransform) {
        switch (transform.phraseKind) {
            case PhraseKind.SimpleVariable:
                {
                    let ref = (<SimpleVariableTransform>transform).reference;
                    this.variables = [{ name: ref.name, arrayDereferenced: 0, type: ref.type || '' }];
                    this.type = ref.type;
                }
                break;

            case PhraseKind.SubscriptExpression:
                {
                    let v = (<SubscriptExpressionTransform>transform).variable
                    if (v) {
                        this.variables = [v];
                    }
                    this.type = (<SubscriptExpressionTransform>transform).type;
                }
                break;

            case PhraseKind.ListIntrinsic:
                this.variables = (<ListIntrinsicTransform>transform).variables;
                break;

            default:
                if (transform.tokenKind !== TokenKind.Ampersand) {
                    this.type = (<TypeNodeTransform>transform).type;
                }
                break;
        }
    }

}

class CoalesceExpressionTransform implements TypeNodeTransform {

    phraseKind = PhraseKind.CoalesceExpression;
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

    phraseKind = PhraseKind.TernaryExpression;
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

    phraseKind = PhraseKind.SubscriptExpression;
    variable: Variable;
    type: string | TypeResolvable = '';
    private _pushCount = 0;

    push(transform: NodeTransform) {

        if (this._pushCount > 0) {
            return;
        }

        ++this._pushCount;

        switch (transform.phraseKind) {
            case PhraseKind.SimpleVariable:
                {
                    let ref = (<SimpleVariableTransform>transform).reference;
                    if (ref) {
                        this.type = async () => {
                            return TypeString.arrayDereference(await TypeString.resolve(ref.type));
                        };
                        this.variable = { name: ref.name, arrayDereferenced: 1, type: this.type };
                    }
                }
                break;

            case PhraseKind.SubscriptExpression:
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

            case PhraseKind.FunctionCallExpression:
            case PhraseKind.MethodCallExpression:
            case PhraseKind.PropertyAccessExpression:
            case PhraseKind.ScopedCallExpression:
            case PhraseKind.ScopedPropertyAccessExpression:
            case PhraseKind.ArrayCreationExpression:
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

    phraseKind = PhraseKind.InstanceOfExpression;
    type = 'bool';
    private _pushCount = 0;
    private _varName = '';
    private _varType: string | TypeResolvable;

    push(transform: NodeTransform) {

        ++this._pushCount;
        if (this._pushCount === 1) {
            if (transform.phraseKind === PhraseKind.SimpleVariable) {
                let ref = (<SimpleVariableTransform>transform).reference;
                if (ref) {
                    this._varName = ref.name;
                }
            }
        } else if (transform.phraseKind === PhraseKind.InstanceofTypeDesignator) {
            this._varType = async () => {
                return TypeString.resolve((<TypeDesignatorTransform>transform).type);
            };
        }

    }

    get variable() {
        return this._varName && this._varType ? {
            name: this._varName, arrayDereferenced: 0, type: this._varType
        } : null;
    }

}

class FunctionCallExpressionTransform implements TypeNodeTransform {

    phraseKind = PhraseKind.FunctionCallExpression;
    type: string | TypeResolvable = '';

    constructor(public referenceSymbolDelegate: ReferenceSymbolDelegate) { }

    push(transform: NodeTransform) {
        switch (transform.phraseKind) {
            case PhraseKind.FullyQualifiedName:
            case PhraseKind.RelativeQualifiedName:
            case PhraseKind.QualifiedName:
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

    phraseKind = PhraseKind.RelativeScope;
    reference:Reference;
    constructor(public type: string, loc:lsp.Location) {
        this.reference = Reference.create(SymbolKind.Class, type, loc);
        this.reference.altName = 'static';
     }
    push(transform: NodeTransform) { }
}

class TypeDesignatorTransform implements TypeNodeTransform {

    type: string | TypeResolvable = '';

    constructor(public phraseKind: PhraseKind) { }

    push(transform: NodeTransform) {
        switch (transform.phraseKind) {
            case PhraseKind.RelativeScope:
            case PhraseKind.FullyQualifiedName:
            case PhraseKind.RelativeQualifiedName:
            case PhraseKind.QualifiedName:
                this.type = (<TypeNodeTransform>transform).type;
                break;

            default:
                break;
        }
    }

}

class AnonymousClassDeclarationTransform implements TypeNodeTransform {
    phraseKind = PhraseKind.AnonymousClassDeclaration;
    constructor(public type: string) { }
    push(transform: NodeTransform) { }

}

class ObjectCreationExpressionTransform implements TypeNodeTransform {

    phraseKind = PhraseKind.ObjectCreationExpression;
    type: string | TypeResolvable = '';

    push(transform: NodeTransform) {
        if (
            transform.phraseKind === PhraseKind.ClassTypeDesignator ||
            transform.phraseKind === PhraseKind.AnonymousClassDeclaration
        ) {
            this.type = (<TypeNodeTransform>transform).type;
        }
    }

}

class SimpleVariableTransform implements TypeNodeTransform, ReferenceNodeTransform {

    phraseKind = PhraseKind.SimpleVariable;
    reference: Reference;
    private _varTable: VariableTable;

    constructor(loc: lsp.Location, varTable: VariableTable) {
        this._varTable = varTable;
        this.reference = Reference.create(SymbolKind.Variable, '', loc);
    }

    push(transform: NodeTransform) {
        if (transform.tokenKind === TokenKind.VariableName) {
            this.reference.name = (<TokenTransform>transform).text;
            this.reference.type = this._varTable.getType(this.reference.name);
        }
    }

    get type() {
        return this.reference.type;
    }

}

class GlobalVariableTransform implements TypeNodeTransform, ReferenceNodeTransform {

    phraseKind = PhraseKind.SimpleVariable;
    reference: Reference;
    
    constructor(loc: lsp.Location, private varTable: VariableTable) {
        this.reference = Reference.create(SymbolKind.GlobalVariable, '', loc);
    }

    push(transform: NodeTransform) {
        if (transform.tokenKind === TokenKind.VariableName) {
            this.reference.name = (<TokenTransform>transform).text;
            
            let topLevelScope = this.varTable.getScope(0);

            this.reference.type = this.reference.name in topLevelScope.variables ?
                topLevelScope.variables[this.reference.name].type : '';
        }
    }

    get type() {
        return this.reference.type;
    }

}

class FullyQualifiedNameTransform implements TypeNodeTransform, ReferenceNodeTransform {

    phraseKind = PhraseKind.FullyQualifiedName;
    reference: Reference;

    constructor(symbolKind: SymbolKind, loc: lsp.Location) {
        this.reference = Reference.create(symbolKind, '', loc);
    }

    push(transform: NodeTransform) {

        if (transform.phraseKind === PhraseKind.NamespaceName) {
            this.reference.name = (<NamespaceNameTransform>transform).text;
        }

    }

    get type() {
        return this.reference.name;
    }

}

class QualifiedNameTransform implements TypeNodeTransform, ReferenceNodeTransform {

    phraseKind = PhraseKind.QualifiedName;
    reference: Reference;
    private _nameResolver: NameResolver;

    constructor(symbolKind: SymbolKind, loc: lsp.Location, nameResolver: NameResolver) {
        this.reference = Reference.create(symbolKind, '', loc);
        this._nameResolver = nameResolver;
    }

    push(transform: NodeTransform) {

        if (transform.phraseKind === PhraseKind.NamespaceName) {
            let name = (<NamespaceNameTransform>transform).text;
            let lcName = name.toLowerCase();
            this.reference.name = this._nameResolver.resolveNotFullyQualified(name, this.reference.kind);
            if (
                ((this.reference.kind === SymbolKind.Function || this.reference.kind === SymbolKind.Constant) &&
                name !== this.reference.name && name.indexOf('\\') < 0) || (lcName === 'parent' || lcName === 'self')
            ) {
                this.reference.altName = name;
            }
        }

    }

    get type() {
        return this.reference.name;
    }

}

class RelativeQualifiedNameTransform implements TypeNodeTransform, ReferenceNodeTransform {

    phraseKind = PhraseKind.RelativeQualifiedName;
    reference: Reference;
    private _nameResolver: NameResolver;

    constructor(symbolKind: SymbolKind, loc: lsp.Location, nameResolver: NameResolver) {
        this.reference = Reference.create(symbolKind, '', loc);
        this._nameResolver = nameResolver;
    }

    push(transform: NodeTransform) {

        if (transform.phraseKind === PhraseKind.NamespaceName) {
            this.reference.name = this._nameResolver.resolveRelative((<NamespaceNameTransform>transform).text);
        }

    }

    get type() {
        return this.reference.name;
    }

}

class MemberNameTransform implements ReferenceNodeTransform {

    phraseKind = PhraseKind.MemberName;
    reference: Reference;

    constructor(loc: lsp.Location) {
        this.reference = Reference.create(SymbolKind.None, '', loc);
    }

    push(transform: NodeTransform) {
        if (transform.tokenKind === TokenKind.Name) {
            this.reference.name = (<TokenTransform>transform).text;
        }
    }

}

class ScopedMemberNameTransform implements ReferenceNodeTransform {

    phraseKind = PhraseKind.ScopedMemberName;
    reference: Reference;

    constructor(loc: lsp.Location) {
        this.reference = Reference.create(SymbolKind.None, '', loc);
    }

    push(transform: NodeTransform) {
        if (
            transform.tokenKind === TokenKind.VariableName ||
            transform.phraseKind === PhraseKind.Identifier
        ) {
            this.reference.name = (<TextNodeTransform>transform).text;
        }
    }

}

class IdentifierTransform implements TextNodeTransform {
    phraseKind = PhraseKind.Identifier;
    text = '';
    location: lsp.Location;

    push(transform: NodeTransform) {
        this.text = (<TokenTransform>transform).text;
        this.location = (<TokenTransform>transform).location;
    }
}

class MemberAccessExpressionTransform implements TypeNodeTransform, ReferenceNodeTransform {

    reference: Reference;
    private _scope: string | TypeResolvable = '';

    constructor(
        public phraseKind: PhraseKind,
        public symbolKind: SymbolKind,
        public referenceSymbolDelegate: ReferenceSymbolDelegate
    ) { }

    push(transform: NodeTransform) {

        switch (transform.phraseKind) {
            case PhraseKind.ScopedMemberName:
            case PhraseKind.MemberName:
                this.reference = (<ReferenceNodeTransform>transform).reference;
                this.reference.kind = this.symbolKind;
                this.reference.scope = this._scope;
                if (this.symbolKind === SymbolKind.Property && this.reference.name && this.reference.name[0] !== '$') {
                    this.reference.name = '$' + this.reference.name;
                }
                break;

            case PhraseKind.ScopedCallExpression:
            case PhraseKind.MethodCallExpression:
            case PhraseKind.PropertyAccessExpression:
            case PhraseKind.ScopedPropertyAccessExpression:
            case PhraseKind.FunctionCallExpression:
            case PhraseKind.SubscriptExpression:
            case PhraseKind.SimpleVariable:
            case PhraseKind.FullyQualifiedName:
            case PhraseKind.QualifiedName:
            case PhraseKind.RelativeQualifiedName:
            case PhraseKind.EncapsulatedExpression:
            case PhraseKind.RelativeScope:
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

class HeaderTransform implements ReferenceNodeTransform {

    reference: Reference;
    private _kind: SymbolKind;

    constructor(public nameResolver: NameResolver, kind: SymbolKind) {
        this._kind = kind;
    }

    push(transform: NodeTransform) {
        if (transform.tokenKind === TokenKind.Name) {
            let name = (<TokenTransform>transform).text;
            let loc = (<TokenTransform>transform).location;
            this.reference = Reference.create(this._kind, this.nameResolver.resolveRelative(name), loc);
        }
    }

}

class MemberDeclarationTransform implements ReferenceNodeTransform {

    reference: Reference;
    private _kind: SymbolKind;
    private _scope = '';

    constructor(kind: SymbolKind, scope: string) {
        this._kind = kind;
        this._scope = scope;
    }

    push(transform: NodeTransform) {
        if (transform.phraseKind === PhraseKind.Identifier) {
            let name = (<IdentifierTransform>transform).text;
            let loc = (<IdentifierTransform>transform).location;
            this.reference = Reference.create(this._kind, name, loc);
            this.reference.scope = this._scope;
        }
    }

}

class PropertyElementTransform implements ReferenceNodeTransform {

    reference: Reference;
    private _scope = '';

    constructor(scope: string) {
        this._scope = scope;
    }

    push(transform: NodeTransform) {
        if (transform.tokenKind === TokenKind.VariableName) {
            let name = (<IdentifierTransform>transform).text;
            let loc = (<IdentifierTransform>transform).location;
            this.reference = Reference.create(SymbolKind.Property, name, loc);
            this.reference.scope = this._scope;
        }
    }

}

class NamespaceDefinitionTransform implements ReferenceNodeTransform {

    reference: Reference;

    push(transform: NodeTransform) {
        if (transform.phraseKind === PhraseKind.NamespaceName) {
            this.reference = Reference.create(SymbolKind.Namespace, (<NamespaceNameTransform>transform).text, (<NamespaceNameTransform>transform).location);
        }
    }

}

class ParameterDeclarationTransform implements ReferenceNodeTransform {

    reference: Reference;

    push(transform: NodeTransform) {
        if (transform.tokenKind === TokenKind.VariableName) {
            this.reference = Reference.create(SymbolKind.Parameter, (<TokenTransform>transform).text, (<TokenTransform>transform).location);
        }
    }

}

class EncapsulatedExpressionTransform implements ReferenceNodeTransform, TypeNodeTransform {

    phraseKind = PhraseKind.EncapsulatedExpression;
    private _transform: NodeTransform;

    push(transform: NodeTransform) {
        if (transform.phraseKind || (transform.tokenKind >= TokenKind.DirectoryConstant && transform.tokenKind <= TokenKind.IntegerLiteral)) {
            this._transform = transform;
        }
    }

    get reference() {
        return this._transform ? (<ReferenceNodeTransform>this._transform).reference : undefined;
    }

    get type() {
        return this._transform ? (<TypeNodeTransform>this._transform).type : undefined;
    }

}

export class VariableTable {

    private _typeVariableSetStack: VariableSet[];

    constructor() {
        this._typeVariableSetStack = [VariableSet.create(VariableSetKind.Scope)];
    }

    setVariable(v: Variable) {
        if (!v || !v.name || !v.type) {
            return;
        }
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
        const traverser = new TreeTraverser([symbolTable.root]);
        const symbols = traverser.filter((s: PhpSymbol) => {
            return SymbolIndex.isNamedSymbol(s);
        });

        const globalVariables = await symbolStore.getGlobalVariables();
        const visitor = new ReferenceReader(doc, new NameResolver(), symbolStore, symbols, globalVariables);
        doc.traverse(visitor);
        return visitor.refTable;
    }
}