/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import { TreeVisitor } from './types';
import { ParsedDocument, NodeTransform } from './parsedDocument';
import { Phrase, PhraseKind, Token, TokenKind } from 'php7parser';
import { PhpDoc, PhpDocParser, Tag, MethodTagParam } from './phpDoc';
import { PhpSymbol, SymbolKind, SymbolModifier, PhpSymbolDoc } from './symbol';
import { NameResolver } from './nameResolver';
import { TypeString } from './typeString';
import { Location } from 'vscode-languageserver';

export class SymbolReader implements TreeVisitor<Phrase | Token> {

    lastPhpDoc: PhpDoc;
    lastPhpDocLocation: Location;

    private _transformStack: NodeTransform[];
    private _globalVars: Map<string, PhpSymbol> = new Map<string, PhpSymbol>();

    constructor(
        public document: ParsedDocument,
        public nameResolver: NameResolver
    ) {
        this._transformStack = [new FileTransform(this.document.uri, this.document.nodeLocation(this.document.tree))];
    }

    get symbol() {
        return (<FileTransform>this._transformStack[0]).symbol;
    }

    preorder(node: Phrase | Token, spine: (Phrase | Token)[]) {

        let parentNode = <Phrase>(spine.length ? spine[spine.length - 1] : { phraseType: PhraseKind.Unknown, children: [] });
        let parentTransform = this._transformStack[this._transformStack.length - 1];

        if (ParsedDocument.isPhrase(node)) {
            switch (node.kind) {
    
                case PhraseKind.Error:
                    this._transformStack.push(null);
                    return false;
    
                case PhraseKind.NamespaceDefinition:
                    {
                        let t = new NamespaceDefinitionTransform(this.document.nodeLocation(node));
                        this._transformStack.push(t);
                        this.nameResolver.namespace = t.symbol;
                    }
                    break;
    
                case PhraseKind.NamespaceUseDeclaration:
                    this._transformStack.push(new NamespaceUseDeclarationTransform());
                    break;
    
                case PhraseKind.NamespaceUseClauseList:
                case PhraseKind.NamespaceUseGroupClauseList:
                    this._transformStack.push(new NamespaceUseClauseListTransform(node.kind));
                    break;
    
                case PhraseKind.NamespaceUseClause:
                case PhraseKind.NamespaceUseGroupClause:
                    {
                        let t = new NamespaceUseClauseTransform(node.kind, this.document.nodeLocation(node));
                        this._transformStack.push(t);
                        this.nameResolver.rules.push(t.symbol);
                    }
                    break;
    
                case PhraseKind.NamespaceAliasingClause:
                    this._transformStack.push(new NamespaceAliasingClause());
                    break;
    
                case PhraseKind.ConstElement:
                    this._transformStack.push(
                        new ConstElementTransform(this.nameResolver, this.document.nodeLocation(node), this.lastPhpDoc, this.lastPhpDocLocation
                        ));
                    break;
    
                case PhraseKind.FunctionDeclaration:
                    this._transformStack.push(new FunctionDeclarationTransform(
                        this.nameResolver, this.document.nodeLocation(node), this.lastPhpDoc, this.lastPhpDocLocation
                    ));
                    break;
    
                case PhraseKind.FunctionDeclarationHeader:
                    this._transformStack.push(new FunctionDeclarationHeaderTransform());
                    break;
    
                case PhraseKind.ParameterDeclarationList:
                    this._transformStack.push(new DelimiteredListTransform(PhraseKind.ParameterDeclarationList));
                    break;
    
                case PhraseKind.ParameterDeclaration:
                    this._transformStack.push(new ParameterDeclarationTransform(
                        this.document.nodeLocation(node), this.lastPhpDoc, this.lastPhpDocLocation, this.nameResolver
                    ));
                    break;
    
                case PhraseKind.TypeDeclaration:
                    this._transformStack.push(new TypeDeclarationTransform());
                    break;
    
                case PhraseKind.ReturnType:
                    this._transformStack.push(new ReturnTypeTransform());
                    break;
    
                case PhraseKind.FunctionDeclarationBody:
                case PhraseKind.MethodDeclarationBody:
                    this._transformStack.push(new FunctionDeclarationBodyTransform(node.kind));
                    break;
    
                case PhraseKind.ClassDeclaration:
                    {
                        let t = new ClassDeclarationTransform(
                            this.nameResolver, this.document.nodeLocation(node), this.lastPhpDoc, this.lastPhpDocLocation
                        );
                        this._transformStack.push(t);
                        this.nameResolver.pushClass(t.symbol);
                    }
                    break;
    
                case PhraseKind.ClassDeclarationHeader:
                    this._transformStack.push(new ClassDeclarationHeaderTransform());
                    break;
    
                case PhraseKind.ClassBaseClause:
                    this._transformStack.push(new ClassBaseClauseTransform());
                    break;
    
                case PhraseKind.ClassInterfaceClause:
                    this._transformStack.push(new ClassInterfaceClauseTransform());
                    break;
    
                case PhraseKind.QualifiedNameList:
                    if (parentTransform) {
                        this._transformStack.push(new DelimiteredListTransform(PhraseKind.QualifiedNameList));
                    } else {
                        this._transformStack.push(null);
                    }
                    break;
    
                case PhraseKind.ClassDeclarationBody:
                    this._transformStack.push(new TypeDeclarationBodyTransform(PhraseKind.ClassDeclarationBody));
                    break;
    
                case PhraseKind.InterfaceDeclaration:
                    {
                        let t = new InterfaceDeclarationTransform(
                            this.nameResolver, this.document.nodeLocation(node), this.lastPhpDoc, this.lastPhpDocLocation
                        );
                        this._transformStack.push(t);
                        this.nameResolver.pushClass(t.symbol);
                    }
                    break;
    
                case PhraseKind.InterfaceDeclarationHeader:
                    this._transformStack.push(new InterfaceDeclarationHeaderTransform());
                    break;
    
                case PhraseKind.InterfaceBaseClause:
                    this._transformStack.push(new InterfaceBaseClauseTransform());
                    break;
    
                case PhraseKind.InterfaceDeclarationBody:
                    this._transformStack.push(new TypeDeclarationBodyTransform(PhraseKind.InterfaceDeclarationBody));
                    break;
    
                case PhraseKind.TraitDeclaration:
                    this._transformStack.push(new TraitDeclarationTransform(
                        this.nameResolver, this.document.nodeLocation(node), this.lastPhpDoc, this.lastPhpDocLocation
                    ));
                    break;
    
                case PhraseKind.TraitDeclarationHeader:
                    this._transformStack.push(new TraitDeclarationHeaderTransform());
                    break;
    
                case PhraseKind.TraitDeclarationBody:
                    this._transformStack.push(new TypeDeclarationBodyTransform(PhraseKind.TraitDeclarationBody));
                    break;
    
                case PhraseKind.ClassConstDeclaration:
                    this._transformStack.push(new FieldDeclarationTransform(PhraseKind.ClassConstDeclaration));
                    break;
    
                case PhraseKind.ClassConstElementList:
                    this._transformStack.push(new DelimiteredListTransform(PhraseKind.ClassConstElementList));
                    break;
    
                case PhraseKind.ClassConstElement:
                    this._transformStack.push(new ClassConstantElementTransform(
                        this.nameResolver, this.document.nodeLocation(node), this.lastPhpDoc, this.lastPhpDocLocation
                    ));
                    break;
    
                case PhraseKind.PropertyDeclaration:
                    this._transformStack.push(new FieldDeclarationTransform(PhraseKind.PropertyDeclaration));
                    break;
    
                case PhraseKind.PropertyElementList:
                    this._transformStack.push(new DelimiteredListTransform(PhraseKind.PropertyElementList));
                    break;
    
                case PhraseKind.PropertyElement:
                    this._transformStack.push(new PropertyElementTransform(
                        this.nameResolver, this.document.nodeLocation(node), this.lastPhpDoc, this.lastPhpDocLocation
                    ));
                    break;
    
                case PhraseKind.PropertyInitialiser:
                    this._transformStack.push(new PropertyInitialiserTransform());
                    break;
    
                case PhraseKind.TraitUseClause:
                    this._transformStack.push(new TraitUseClauseTransform());
                    break;
    
                case PhraseKind.MethodDeclaration:
                    this._transformStack.push(new MethodDeclarationTransform(
                        this.nameResolver, this.document.nodeLocation(node), this.lastPhpDoc, this.lastPhpDocLocation
                    ));
                    break;
    
                case PhraseKind.MethodDeclarationHeader:
                    this._transformStack.push(new MethodDeclarationHeaderTransform());
                    break;
    
                case PhraseKind.Identifier:
                    if (
                        parentNode.kind === PhraseKind.MethodDeclarationHeader ||
                        parentNode.kind === PhraseKind.ClassConstElement
                    ) {
                        this._transformStack.push(new IdentifierTransform());
                    } else {
                        this._transformStack.push(null);
                    }
                    break;
    
                case PhraseKind.MemberModifierList:
                    this._transformStack.push(new MemberModifierListTransform());
                    break;
    
                case PhraseKind.AnonymousClassDeclaration:
                    {
                        let t = new AnonymousClassDeclarationTransform(
                            this.document.nodeLocation(node), this.document.createAnonymousName(<Phrase>node)
                        );
                        this._transformStack.push(t);
                        this.nameResolver.pushClass(t.symbol);
                    }
                    break;
    
                case PhraseKind.AnonymousClassDeclarationHeader:
                    this._transformStack.push(new AnonymousClassDeclarationHeaderTransform());
                    break;
    
                case PhraseKind.AnonymousFunctionCreationExpression:
                    this._transformStack.push(new AnonymousFunctionCreationExpressionTransform(
                        this.document.nodeLocation(node), this.document.createAnonymousName(<Phrase>node)
                    ));
                    break;
    
                case PhraseKind.AnonymousFunctionHeader:
                    this._transformStack.push(new AnonymousFunctionHeaderTransform());
                    break;
    
                case PhraseKind.AnonymousFunctionUseClause:
                    this._transformStack.push(new AnonymousFunctionUseClauseTransform());
                    break;
    
                case PhraseKind.ClosureUseList:
                    this._transformStack.push(new DelimiteredListTransform(PhraseKind.ClosureUseList));
                    break;
    
                case PhraseKind.AnonymousFunctionUseVariable:
                    this._transformStack.push(new AnonymousFunctionUseVariableTransform(this.document.nodeLocation(node)));
                    break;
    
                case PhraseKind.SimpleVariable:
                    this._transformStack.push(new SimpleVariableTransform(this.document.nodeLocation(node)));
                    break;
    
                case PhraseKind.FunctionCallExpression:
                    //define
                    if ((<Phrase>node).children.length) {
                        let name = this.document.nodeText((<Phrase>node).children[0]).toLowerCase();
                        if (name === 'define' || name === '\\define') {
                            this._transformStack.push(new DefineFunctionCallExpressionTransform(this.document.nodeLocation(node)));
                            break;
                        }
                    }
                    this._transformStack.push(null);
                    break;
    
                case PhraseKind.ArgumentExpressionList:
                    if (parentNode.kind === PhraseKind.FunctionCallExpression && parentTransform) {
                        this._transformStack.push(new DelimiteredListTransform(PhraseKind.ArgumentExpressionList));
                    } else {
                        this._transformStack.push(null);
                    }
                    break;
    
                case PhraseKind.FullyQualifiedName:
                    if (parentTransform) {
                        this._transformStack.push(new FullyQualifiedNameTransform());
                    } else {
                        this._transformStack.push(null);
                    }
                    break;
    
                case PhraseKind.RelativeQualifiedName:
                    if (parentTransform) {
                        this._transformStack.push(new RelativeQualifiedNameTransform(this.nameResolver));
                    } else {
                        this._transformStack.push(null);
                    }
                    break;
    
                case PhraseKind.QualifiedName:
                    if (parentTransform) {
                        this._transformStack.push(new QualifiedNameTransform(this.nameResolver));
                    } else {
                        this._transformStack.push(null);
                    }
                    break;
    
                case PhraseKind.NamespaceName:
                    if (parentTransform) {
                        this._transformStack.push(new NamespaceNameTransform());
                    } else {
                        this._transformStack.push(null);
                    }
                    break;
                
                case PhraseKind.GlobalDeclaration:
                    if (this.lastPhpDoc && this.lastPhpDoc.globalTags.length > 0) {
                        const transform = new GlobalVariableTransform(
                            this.nameResolver,
                            this._globalVars,
                            this.document.nodeLocation(node),
                            this.lastPhpDoc,
                            this.lastPhpDocLocation
                        );
                        this._transformStack.push(transform);
                    } else {
                        this._transformStack.push(null);
                    }
                    break;
                case PhraseKind.SimpleAssignmentExpression:
                    if (this._globalVars.size > 0) {
                        this._transformStack.push(new SimpleAssignmentTransform(this._globalVars));
                    } else {
                        this._transformStack.push(null);
                    }
                    break;
                case PhraseKind.ClassTypeDesignator:
                case PhraseKind.InstanceofTypeDesignator:
                    this._transformStack.push(new TypeDesignatorTransform());
                    break;
    
                default:
    
                    if (
                        parentNode.kind === PhraseKind.ConstElement ||
                        parentNode.kind === PhraseKind.ClassConstElement ||
                        parentNode.kind === PhraseKind.ParameterDeclaration ||
                        (parentNode.kind === PhraseKind.ArgumentExpressionList && parentTransform)
                    ) {
                        this._transformStack.push(
                            new DefaultNodeTransform(
                                node.kind,
                                this.document.nodeText(node)
                            )
                        );
                    } else {
                        this._transformStack.push(null);
                    }
                    break;
            }
        } else {
            if (node.kind === TokenKind.DocumentComment) {
    
                this.lastPhpDoc = PhpDocParser.parse(this.document.nodeText(node));
                this.lastPhpDocLocation = this.document.nodeLocation(node);

            } else if (node.kind === TokenKind.CloseBrace) {

                this.lastPhpDoc = null;
                this.lastPhpDocLocation = null;

            } else if (node.kind === TokenKind.VariableName && parentNode.kind === PhraseKind.CatchClause) {
                //catch clause vars
                for (let n = this._transformStack.length - 1; n > -1; --n) {
                    if (this._transformStack[n]) {
                        this._transformStack[n].push(
                            new CatchClauseVariableNameTransform(
                                this.document.tokenText(<Token>node),
                                this.document.nodeLocation(node)
                            )
                        );
                        break;
                    }
                }

            } else if (parentTransform && node.kind > TokenKind.EndOfFile && node.kind < TokenKind.Equals) {

                parentTransform.push(new TokenTransform(<Token>node, this.document));

            }
        }

        return true;

    }

    postorder(node: Phrase | Token, spine: (Phrase | Token)[]) {

        if (!ParsedDocument.isPhrase(node)) {
            return;
        }

        let transform = this._transformStack.pop();
        if (!transform) {
            return;
        }

        for (let n = this._transformStack.length - 1; n > -1; --n) {
            if (this._transformStack[n]) {
                this._transformStack[n].push(transform);
                break;
            }
        }

        switch (node.kind) {
            case PhraseKind.ClassDeclarationHeader:
            case PhraseKind.InterfaceDeclarationHeader:
            case PhraseKind.AnonymousClassDeclarationHeader:
            case PhraseKind.FunctionDeclarationHeader:
            case PhraseKind.MethodDeclarationHeader:
            case PhraseKind.TraitDeclarationHeader:
            case PhraseKind.AnonymousFunctionHeader:
            case PhraseKind.GlobalDeclaration:
                this.lastPhpDoc = null;
                this.lastPhpDocLocation = null;
                break;

            default:
                break;
        }

    }

}

/**
 * Ensures that there are no variable and parameter symbols with same name
 * and excludes inbuilt vars
 */
class UniqueSymbolCollection {

    private _symbols: PhpSymbol[];
    private _varMap: { [index: string]: boolean };
    private static _inbuilt = {
        '$GLOBALS': true,
        '$_SERVER': true,
        '$_GET': true,
        '$_POST': true,
        '$_FILES': true,
        '$_REQUEST': true,
        '$_SESSION': true,
        '$_ENV': true,
        '$_COOKIE': true,
        '$php_errormsg': true,
        '$HTTP_RAW_POST_DATA': true,
        '$http_response_header': true,
        '$argc': true,
        '$argv': true,
        '$this': true
    };

    constructor() {
        this._symbols = [];
        this._varMap = Object.assign({}, UniqueSymbolCollection._inbuilt);
    }

    get length() {
        return this._symbols.length;
    }

    push(s: PhpSymbol) {
        if (s.kind & (SymbolKind.Parameter | SymbolKind.Variable)) {
            if (this._varMap[s.name] === undefined) {
                this._varMap[s.name] = true;
                this._symbols.push(s);
            }
        } else {
            this._symbols.push(s);
        }
    }

    pushMany(symbols: PhpSymbol[]) {
        for (let n = 0, l = symbols.length; n < l; ++n) {
            this.push(symbols[n]);
        }
    }

    toArray() {
        return this._symbols;
    }
}

interface SymbolNodeTransform extends NodeTransform {
    symbol: PhpSymbol;
}

interface NameNodeTransform extends NodeTransform {
    name: string;
    unresolved: string;
}

interface TextNodeTransform extends NodeTransform {
    text: string;
}

interface SymbolsNodeTransform extends NodeTransform {
    symbols: PhpSymbol[];
}

class FileTransform implements SymbolNodeTransform {

    private _children: UniqueSymbolCollection;
    private _symbol: PhpSymbol;

    constructor(uri: string, location: Location) {
        this._symbol = PhpSymbol.create(SymbolKind.File, uri, location);
        this._children = new UniqueSymbolCollection();
    }

    push(transform: NodeTransform) {

        let s = (<SymbolNodeTransform>transform).symbol;
        if (s) {
            this._children.push(s);
            return;
        }

        let symbols = (<SymbolsNodeTransform>transform).symbols;
        if (symbols) {
            this._children.pushMany(symbols);
        }

    }

    get symbol() {
        this._symbol.children = this._children.toArray();
        return this._symbol;
    }

}

class DelimiteredListTransform implements NodeTransform {

    transforms: NodeTransform[];

    constructor(public phraseKind: PhraseKind) {
        this.transforms = [];
    }

    push(transform: NodeTransform) {
        this.transforms.push(transform);
    }

}

class TokenTransform implements TextNodeTransform {

    constructor(public token: Token, public doc: ParsedDocument) { }

    push(transform: NodeTransform) { }

    get text() {
        return this.doc.tokenText(this.token);
    }

    get tokenKind() {
        return this.token.kind;
    }

    get location() {
        return this.doc.nodeLocation(this.token);
    }

}

class NamespaceNameTransform implements TextNodeTransform {

    phraseKind = PhraseKind.NamespaceName;
    private _parts: string[];

    constructor() {
        this._parts = [];
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

class QualifiedNameTransform implements NameNodeTransform {

    phraseKind = PhraseKind.QualifiedName;
    name = '';
    unresolved = '';
    constructor(public nameResolver: NameResolver) { }
    push(transform: NodeTransform) {
        if (transform.phraseKind === PhraseKind.NamespaceName) {
            this.unresolved = (<NamespaceNameTransform>transform).text;
            this.name = this.nameResolver.resolveNotFullyQualified(this.unresolved);
        }
    }

}

class RelativeQualifiedNameTransform implements NameNodeTransform {

    phraseKind = PhraseKind.RelativeQualifiedName;
    name = '';
    unresolved = '';
    constructor(public nameResolver: NameResolver) { }

    push(transform: NodeTransform) {
        if (transform.phraseKind === PhraseKind.NamespaceName) {
            this.unresolved = (<NamespaceNameTransform>transform).text;
            this.name = this.nameResolver.resolveRelative(this.unresolved);
        }
    }

}

class FullyQualifiedNameTransform implements NameNodeTransform {

    phraseKind = PhraseKind.FullyQualifiedName;
    name = '';
    unresolved = '';
    push(transform: NodeTransform) {
        if (transform.phraseKind === PhraseKind.NamespaceName) {
            this.name = this.unresolved = (<NamespaceNameTransform>transform).text;
        }
    }

}

class CatchClauseVariableNameTransform implements SymbolNodeTransform {
    tokenKind = TokenKind.VariableName;
    symbol: PhpSymbol;
    constructor(name: string, location: Location) {
        this.symbol = PhpSymbol.create(SymbolKind.Variable, name, location);
    }
    push(transform: NodeTransform) { }
}

class ParameterDeclarationTransform implements SymbolNodeTransform {

    phraseKind = PhraseKind.ParameterDeclaration;
    symbol: PhpSymbol;
    private _doc: PhpDoc;
    private _nameResolver: NameResolver;
    private _docLocation: Location;

    constructor(location: Location, doc: PhpDoc, docLocation: Location, nameResolver: NameResolver) {
        this.symbol = PhpSymbol.create(SymbolKind.Parameter, '', location);
        this._doc = doc;
        this._docLocation = docLocation;
        this._nameResolver = nameResolver;
    }

    push(transform: NodeTransform) {
        if (transform.phraseKind === PhraseKind.TypeDeclaration) {
            this.symbol.type = (<TypeDeclarationTransform>transform).type;
        } else if (transform.tokenKind === TokenKind.Ampersand) {
            this.symbol.modifiers |= SymbolModifier.Reference;
        } else if (transform.tokenKind === TokenKind.Ellipsis) {
            this.symbol.modifiers |= SymbolModifier.Variadic;
        } else if (transform.tokenKind === TokenKind.VariableName) {
            this.symbol.name = (<TokenTransform>transform).text;
            SymbolReader.assignPhpDocInfoToSymbol(this.symbol, this._doc, this._docLocation, this._nameResolver);
        } else {
            this.symbol.value = (<TextNodeTransform>transform).text;
        }
    }

}

class DefineFunctionCallExpressionTransform implements SymbolNodeTransform {

    phraseKind = PhraseKind.FunctionCallExpression;
    symbol: PhpSymbol;
    constructor(location: Location) {
        this.symbol = PhpSymbol.create(SymbolKind.Constant, '', location);
    }

    push(transform: NodeTransform) {
        if (transform.phraseKind === PhraseKind.ArgumentExpressionList) {

            let arg1: TextNodeTransform, arg2: TextNodeTransform;
            [arg1, arg2] = (<DelimiteredListTransform>transform).transforms as TextNodeTransform[];

            if (arg1 && arg1.tokenKind === TokenKind.StringLiteral) {
                this.symbol.name = arg1.text.slice(1, -1); //remove quotes
            }

            //todo --this could be an array or constant too
            if (arg2 && (arg2.tokenKind === TokenKind.FloatingLiteral ||
                arg2.tokenKind === TokenKind.IntegerLiteral ||
                arg2.tokenKind === TokenKind.StringLiteral)) {
                this.symbol.value = arg2.text;
            }

            if (this.symbol.name && this.symbol.name[0] === '\\') {
                this.symbol.name = this.symbol.name.slice(1);
            }
        }
    }

}

class SimpleVariableTransform implements SymbolNodeTransform {

    phraseKind = PhraseKind.SimpleVariable;
    symbol: PhpSymbol;
    constructor(location: Location) {
        this.symbol = PhpSymbol.create(SymbolKind.Variable, '', location);
    }

    push(transform: NodeTransform) {
        if (transform.tokenKind === TokenKind.VariableName) {
            this.symbol.name = (<TokenTransform>transform).text;
        }
    }

}

class AnonymousClassDeclarationTransform implements SymbolNodeTransform {

    phraseKind = PhraseKind.AnonymousClassDeclaration;
    symbol: PhpSymbol;

    constructor(location: Location, name: string) {
        this.symbol = PhpSymbol.create(SymbolKind.Class, name, location);
        this.symbol.modifiers = SymbolModifier.Anonymous;
        this.symbol.children = [];
        this.symbol.associated = [];
    }

    push(transform: NodeTransform) {
        if (transform.phraseKind === PhraseKind.AnonymousClassDeclarationHeader) {
            if ((<AnonymousClassDeclarationHeaderTransform>transform).base) {
                this.symbol.associated.push((<AnonymousClassDeclarationHeaderTransform>transform).base);
            }
            Array.prototype.push.apply(this.symbol.associated, (<AnonymousClassDeclarationHeaderTransform>transform).interfaces);
        } else if (transform.phraseKind === PhraseKind.ClassDeclarationBody) {
            Array.prototype.push.apply(this.symbol.children, PhpSymbol.setScope((<TypeDeclarationBodyTransform>transform).declarations, this.symbol.name))
            Array.prototype.push.apply(this.symbol.associated, (<TypeDeclarationBodyTransform>transform).useTraits);
        }
    }

}

class TypeDeclarationBodyTransform implements NodeTransform {

    declarations: PhpSymbol[];
    useTraits: PhpSymbol[];

    constructor(public phraseKind: PhraseKind) {
        this.declarations = [];
        this.useTraits = [];
    }

    push(transform: NodeTransform) {

        switch (transform.phraseKind) {
            case PhraseKind.ClassConstDeclaration:
            case PhraseKind.PropertyDeclaration:
                Array.prototype.push.apply(this.declarations, (<FieldDeclarationTransform>transform).symbols);
                break;

            case PhraseKind.MethodDeclaration:
                this.declarations.push((<MethodDeclarationTransform>transform).symbol);
                break;

            case PhraseKind.TraitUseClause:
                Array.prototype.push.apply(this.useTraits, (<TraitUseClauseTransform>transform).symbols);
                break;

            default:
                break;

        }
    }

}

class AnonymousClassDeclarationHeaderTransform implements NodeTransform {

    phraseKind = PhraseKind.AnonymousClassDeclarationHeader;
    base: PhpSymbol;
    interfaces: PhpSymbol[];

    constructor() {
        this.interfaces = [];
    }

    push(transform: NodeTransform) {

        if (transform.phraseKind === PhraseKind.ClassBaseClause) {
            this.base = (<ClassBaseClauseTransform>transform).symbol;
        } else if (transform.phraseKind === PhraseKind.ClassInterfaceClause) {
            this.interfaces = (<ClassInterfaceClauseTransform>transform).symbols;
        }

    }

}

class AnonymousFunctionCreationExpressionTransform implements SymbolNodeTransform {

    phraseKind = PhraseKind.AnonymousFunctionCreationExpression;
    private _symbol: PhpSymbol;
    private _children: UniqueSymbolCollection;

    constructor(location: Location, name: string) {
        this._symbol = PhpSymbol.create(SymbolKind.Function, name, location);
        this._symbol.modifiers = SymbolModifier.Anonymous;
        this._children = new UniqueSymbolCollection();
    }

    push(transform: NodeTransform) {
        if (transform.phraseKind === PhraseKind.AnonymousFunctionHeader) {
            this._symbol.modifiers |= (<AnonymousFunctionHeaderTransform>transform).modifier;
            this._children.pushMany((<AnonymousFunctionHeaderTransform>transform).parameters);
            this._children.pushMany((<AnonymousFunctionHeaderTransform>transform).uses);
            this._symbol.type = (<AnonymousFunctionHeaderTransform>transform).returnType;
        } else if (transform.phraseKind === PhraseKind.FunctionDeclarationBody) {
            this._children.pushMany((<FunctionDeclarationBodyTransform>transform).symbols);
        }
    }

    get symbol() {
        this._symbol.children = PhpSymbol.setScope(this._children.toArray(), this._symbol.name);
        return this._symbol;
    }

}

class AnonymousFunctionHeaderTransform implements NodeTransform {

    phraseKind = PhraseKind.AnonymousFunctionHeader;
    modifier = SymbolModifier.None;
    parameters: PhpSymbol[];
    uses: PhpSymbol[];
    returnType = '';

    constructor() {
        this.parameters = [];
        this.uses = [];
    }

    push(transform: NodeTransform) {
        if (transform.tokenKind === TokenKind.Ampersand) {
            this.modifier |= SymbolModifier.Reference;
        } else if (transform.tokenKind === TokenKind.Static) {
            this.modifier |= SymbolModifier.Static;
        } else if (transform.phraseKind === PhraseKind.ParameterDeclarationList) {
            let transforms = (<DelimiteredListTransform>transform).transforms as SymbolNodeTransform[];
            for (let n = 0; n < transforms.length; ++n) {
                this.parameters.push(transforms[n].symbol);
            }
        } else if (transform.phraseKind === PhraseKind.AnonymousFunctionUseClause) {
            let symbols = (<AnonymousFunctionUseClauseTransform>transform).symbols;
            for (let n = 0; n < symbols.length; ++n) {
                this.uses.push(symbols[n]);
            }
        } else if (transform.phraseKind === PhraseKind.ReturnType) {
            this.returnType = (<ReturnTypeTransform>transform).type;
        }
    }

}

class FunctionDeclarationBodyTransform implements SymbolsNodeTransform {

    private _value: UniqueSymbolCollection;

    constructor(public phraseKind: PhraseKind) {
        this._value = new UniqueSymbolCollection();
    }

    push(transform: NodeTransform) {

        switch (transform.phraseKind) {
            case PhraseKind.SimpleVariable:
            case PhraseKind.AnonymousFunctionCreationExpression:
            case PhraseKind.AnonymousClassDeclaration:
            case PhraseKind.FunctionCallExpression: //define    
                this._value.push((<SymbolNodeTransform>transform).symbol);
                break;

            case undefined:
                //catch clause vars
                if (transform instanceof CatchClauseVariableNameTransform) {
                    this._value.push(transform.symbol);
                }
                break;

            default:
                break;
        }

    }

    get symbols() {
        return this._value.toArray();
    }

}

class AnonymousFunctionUseClauseTransform implements SymbolsNodeTransform {

    phraseKind = PhraseKind.AnonymousFunctionUseClause;
    symbols: PhpSymbol[];

    constructor() {
        this.symbols = [];
    }

    push(transform: NodeTransform) {
        if (transform.phraseKind === PhraseKind.ClosureUseList) {
            let transforms = (<DelimiteredListTransform>transform).transforms as SymbolNodeTransform[];
            for (let n = 0; n < transforms.length; ++n) {
                this.symbols.push(transforms[n].symbol);
            }
        }
    }

}

class AnonymousFunctionUseVariableTransform implements SymbolNodeTransform {

    phraseKind = PhraseKind.AnonymousFunctionUseVariable;
    symbol: PhpSymbol;

    constructor(location: Location) {
        this.symbol = PhpSymbol.create(SymbolKind.Variable, '', location);
        this.symbol.modifiers = SymbolModifier.Use;
    }

    push(transform: NodeTransform) {
        if (transform.tokenKind === TokenKind.VariableName) {
            this.symbol.name = (<TokenTransform>transform).text;
        } else if (transform.tokenKind === TokenKind.Ampersand) {
            this.symbol.modifiers |= SymbolModifier.Reference;
        }
    }

}

class InterfaceDeclarationTransform implements SymbolNodeTransform {

    phraseKind = PhraseKind.InterfaceDeclaration;
    symbol: PhpSymbol;

    constructor(public nameResolver: NameResolver, location: Location, doc: PhpDoc, docLocation: Location) {
        this.symbol = PhpSymbol.create(SymbolKind.Interface, '', location);
        SymbolReader.assignPhpDocInfoToSymbol(this.symbol, doc, docLocation, nameResolver);
        this.symbol.children = [];
        this.symbol.associated = [];
    }

    push(transform: NodeTransform) {
        if (transform.phraseKind === PhraseKind.InterfaceDeclarationHeader) {
            this.symbol.name = this.nameResolver.resolveRelative((<InterfaceDeclarationHeaderTransform>transform).name);
            this.symbol.associated = (<InterfaceDeclarationHeaderTransform>transform).extends;
        } else if (transform.phraseKind === PhraseKind.InterfaceDeclarationBody) {
            Array.prototype.push.apply(this.symbol.children, PhpSymbol.setScope((<TypeDeclarationBodyTransform>transform).declarations, this.symbol.name));
        }
    }

}

class ConstElementTransform implements SymbolNodeTransform {

    phraseKind = PhraseKind.ConstElement;
    symbol: PhpSymbol;
    private _doc: PhpDoc;
    private _docLocation: Location;

    constructor(public nameResolver: NameResolver, location: Location, doc: PhpDoc, docLocation: Location) {
        this.symbol = PhpSymbol.create(SymbolKind.Constant, '', location);
        this.symbol.scope = this.nameResolver.namespaceName;
        this._doc = doc;
        this._docLocation = docLocation;
    }

    push(transform: NodeTransform) {

        if (transform.tokenKind === TokenKind.Name) {
            this.symbol.name = this.nameResolver.resolveRelative((<TokenTransform>transform).text);
            SymbolReader.assignPhpDocInfoToSymbol(this.symbol, this._doc, this._docLocation, this.nameResolver);
        } else {
            //expression
            this.symbol.value = (<TextNodeTransform>transform).text;
        }

    }

}

class TraitDeclarationTransform implements SymbolNodeTransform {

    phraseKind = PhraseKind.TraitDeclaration;
    symbol: PhpSymbol;

    constructor(public nameResolver: NameResolver, location: Location, doc: PhpDoc, docLocation: Location) {
        this.symbol = PhpSymbol.create(SymbolKind.Trait, '', location);
        SymbolReader.assignPhpDocInfoToSymbol(this.symbol, doc, docLocation, nameResolver);
        this.symbol.children = [];
        this.symbol.associated = [];
    }

    push(transform: NodeTransform) {
        if (transform.phraseKind === PhraseKind.TraitDeclarationHeader) {
            this.symbol.name = this.nameResolver.resolveRelative((<TraitDeclarationHeaderTransform>transform).name);
        } else if (transform.phraseKind === PhraseKind.TraitDeclarationBody) {
            Array.prototype.push.apply(this.symbol.children, PhpSymbol.setScope((<TypeDeclarationBodyTransform>transform).declarations, this.symbol.name));
            Array.prototype.push.apply(this.symbol.associated, (<TypeDeclarationBodyTransform>transform).useTraits);
        }
    }

}

class TraitDeclarationHeaderTransform implements NodeTransform {
    phraseKind = PhraseKind.TraitDeclarationHeader;
    name = '';

    push(transform: NodeTransform) {
        if (transform.tokenKind === TokenKind.Name) {
            this.name = (<TokenTransform>transform).text;
        }
    }

}

class InterfaceBaseClauseTransform implements SymbolsNodeTransform {
    phraseKind = PhraseKind.InterfaceBaseClause;
    symbols: PhpSymbol[];

    constructor() {
        this.symbols = [];
    }

    push(transform: NodeTransform) {
        if (transform.phraseKind === PhraseKind.QualifiedNameList) {
            let transforms = (<DelimiteredListTransform>transform).transforms as NameNodeTransform[];
            for (let n = 0; n < transforms.length; ++n) {
                this.symbols.push(PhpSymbol.create(SymbolKind.Interface, transforms[n].name));
            }
        }
    }

}

class InterfaceDeclarationHeaderTransform implements NodeTransform {
    phraseKind = PhraseKind.InterfaceDeclarationHeader;
    name = '';
    extends: PhpSymbol[];

    constructor() {
        this.extends = [];
    }

    push(transform: NodeTransform) {
        if (transform.tokenKind === TokenKind.Name) {
            this.name = (<TokenTransform>transform).text;
        } else if (transform.phraseKind === PhraseKind.InterfaceBaseClause) {
            this.extends = (<InterfaceBaseClauseTransform>transform).symbols;
        }
    }

}

class TraitUseClauseTransform implements SymbolsNodeTransform {

    phraseKind = PhraseKind.TraitUseClause;
    symbols: PhpSymbol[];

    constructor() {
        this.symbols = [];
    }

    push(transform: NodeTransform) {
        if (transform.phraseKind === PhraseKind.QualifiedNameList) {
            let transforms = (<DelimiteredListTransform>transform).transforms as NameNodeTransform[];
            for (let n = 0; n < transforms.length; ++n) {
                this.symbols.push(PhpSymbol.create(SymbolKind.Trait, transforms[n].name));
            }
        }
    }

}

class ClassInterfaceClauseTransform implements SymbolsNodeTransform {
    phraseKind = PhraseKind.ClassInterfaceClause;
    symbols: PhpSymbol[];

    constructor() {
        this.symbols = [];
    }

    push(transform: NodeTransform) {
        if (transform.phraseKind === PhraseKind.QualifiedNameList) {
            let transforms = (<DelimiteredListTransform>transform).transforms as NameNodeTransform[];
            for (let n = 0; n < transforms.length; ++n) {
                this.symbols.push(PhpSymbol.create(SymbolKind.Interface, transforms[n].name));
            }
        }
    }
}

class NamespaceDefinitionTransform implements SymbolNodeTransform {

    phraseKind = PhraseKind.NamespaceDefinition;
    private _symbol: PhpSymbol;
    private _children: UniqueSymbolCollection;

    constructor(location: Location) {
        this._symbol = PhpSymbol.create(SymbolKind.Namespace, '', location);
        this._children = new UniqueSymbolCollection();
    }

    push(transform: NodeTransform) {
        if (transform.phraseKind === PhraseKind.NamespaceName) {
            this._symbol.name = (<NamespaceNameTransform>transform).text;
        } else {
            let s = (<SymbolNodeTransform>transform).symbol;
            if (s) {
                this._children.push(s);
                return;
            }

            let symbols = (<SymbolsNodeTransform>transform).symbols;
            if (symbols) {
                this._children.pushMany(symbols);
            }
        }
    }

    get symbol() {
        if (this._children.length > 0) {
            this._symbol.children = this._children.toArray();
        }

        return this._symbol;
    }
}

class ClassDeclarationTransform implements SymbolNodeTransform {

    phraseKind = PhraseKind.ClassDeclaration;
    symbol: PhpSymbol;

    constructor(public nameResolver: NameResolver, location: Location, doc: PhpDoc, docLocation: Location) {
        this.symbol = PhpSymbol.create(SymbolKind.Class, '', location);
        this.symbol.children = [];
        this.symbol.associated = [];
        SymbolReader.assignPhpDocInfoToSymbol(this.symbol, doc, docLocation, nameResolver);
    }

    push(transform: NodeTransform) {

        if (transform instanceof ClassDeclarationHeaderTransform) {
            this.symbol.modifiers = transform.modifier;
            this.symbol.name = this.nameResolver.resolveRelative(transform.name);
            if (transform.extends) {
                this.symbol.associated.push(transform.extends);
            }
            Array.prototype.push.apply(this.symbol.associated, transform.implements);
        } else if (transform.phraseKind === PhraseKind.ClassDeclarationBody) {
            Array.prototype.push.apply(this.symbol.children, PhpSymbol.setScope((<TypeDeclarationBodyTransform>transform).declarations, this.symbol.name));
            Array.prototype.push.apply(this.symbol.associated, (<TypeDeclarationBodyTransform>transform).useTraits);
        }

    }

}

class ClassDeclarationHeaderTransform implements NodeTransform {

    phraseKind = PhraseKind.ClassDeclarationHeader;
    modifier = SymbolModifier.None;
    name = '';
    extends: PhpSymbol;
    implements: PhpSymbol[];

    constructor() {
        this.implements = [];
    }

    push(transform: NodeTransform) {

        if (transform.tokenKind === TokenKind.Abstract) {
            this.modifier = SymbolModifier.Abstract;
        } else if (transform.tokenKind === TokenKind.Final) {
            this.modifier = SymbolModifier.Final;
        } else if (transform.tokenKind === TokenKind.Name) {
            this.name = (<TokenTransform>transform).text;
        } else if (transform.phraseKind === PhraseKind.ClassBaseClause) {
            this.extends = (<ClassBaseClauseTransform>transform).symbol;
        } else if (transform.phraseKind === PhraseKind.ClassInterfaceClause) {
            this.implements = (<ClassInterfaceClauseTransform>transform).symbols;
        }

    }

}

class ClassBaseClauseTransform implements SymbolNodeTransform {

    phraseKind = PhraseKind.ClassBaseClause;
    symbol: PhpSymbol;

    constructor() {
        this.symbol = PhpSymbol.create(SymbolKind.Class, '');
    }

    push(transform: NodeTransform) {
        switch (transform.phraseKind) {
            case PhraseKind.FullyQualifiedName:
            case PhraseKind.RelativeQualifiedName:
            case PhraseKind.QualifiedName:
                this.symbol.name = (<NameNodeTransform>transform).name;
                break;

            default:
                break;
        }
    }

}

class MemberModifierListTransform implements NodeTransform {

    phraseKind = PhraseKind.MemberModifierList;
    modifiers = SymbolModifier.None;

    push(transform: NodeTransform) {
        switch (transform.tokenKind) {
            case TokenKind.Public:
                this.modifiers |= SymbolModifier.Public;
                break;
            case TokenKind.Protected:
                this.modifiers |= SymbolModifier.Protected;
                break;
            case TokenKind.Private:
                this.modifiers |= SymbolModifier.Private;
                break;
            case TokenKind.Abstract:
                this.modifiers |= SymbolModifier.Abstract;
                break;
            case TokenKind.Final:
                this.modifiers |= SymbolModifier.Final;
                break;
            case TokenKind.Static:
                this.modifiers |= SymbolModifier.Static;
                break;
            default:
                break;
        }
    }

}

class ClassConstantElementTransform implements SymbolNodeTransform {

    phraseKind = PhraseKind.ClassConstElement;
    symbol: PhpSymbol;
    private _docLocation: Location;
    private _doc: PhpDoc;

    constructor(public nameResolver: NameResolver, location: Location, doc: PhpDoc, docLocation: Location) {
        this.symbol = PhpSymbol.create(SymbolKind.ClassConstant, '', location);
        this.symbol.modifiers = SymbolModifier.Static;
        this._doc = doc;
        this._docLocation = docLocation;
    }

    push(transform: NodeTransform) {
        if (transform.phraseKind === PhraseKind.Identifier) {
            this.symbol.name = (<IdentifierTransform>transform).text;
            SymbolReader.assignPhpDocInfoToSymbol(this.symbol, this._doc, this._docLocation, this.nameResolver)
        } else {
            this.symbol.value = (<TextNodeTransform>transform).text;
        }
    }

}

class MethodDeclarationTransform implements SymbolNodeTransform {

    phraseKind = PhraseKind.MethodDeclaration;
    private _children: UniqueSymbolCollection;
    private _symbol: PhpSymbol;

    constructor(public nameResolver: NameResolver, location: Location, doc: PhpDoc, docLocation: Location) {
        this._symbol = PhpSymbol.create(SymbolKind.Method, '', location);
        SymbolReader.assignPhpDocInfoToSymbol(this._symbol, doc, docLocation, nameResolver);
        this._children = new UniqueSymbolCollection();
    }

    push(transform: NodeTransform) {

        if (transform instanceof MethodDeclarationHeaderTransform) {
            this._symbol.modifiers = transform.modifiers;
            this._symbol.name = transform.name;
            this._children.pushMany(transform.parameters);
            this._symbol.type = transform.returnType;
        } else if (transform.phraseKind === PhraseKind.MethodDeclarationBody) {
            this._children.pushMany((<FunctionDeclarationBodyTransform>transform).symbols);
        }

    }

    get symbol() {
        this._symbol.children = PhpSymbol.setScope(this._children.toArray(), this._symbol.name);
        return this._symbol;
    }

}

class ReturnTypeTransform implements NodeTransform {

    phraseKind = PhraseKind.ReturnType;
    type = '';

    push(transform: NodeTransform) {
        if (transform.phraseKind === PhraseKind.TypeDeclaration) {
            this.type = (<TypeDeclarationTransform>transform).type;
        }
    }

}

class TypeDeclarationTransform implements NodeTransform {

    phraseKind = PhraseKind.TypeDeclaration;
    type = '';
    private static _scalarTypes:{[name:string]:number} = { 'int': 1, 'string': 1, 'bool': 1, 'float': 1, 'iterable': 1 };

    push(transform: NodeTransform) {

        switch (transform.phraseKind) {
            case PhraseKind.FullyQualifiedName:
            case PhraseKind.RelativeQualifiedName:
            case PhraseKind.QualifiedName:
                if (TypeDeclarationTransform._scalarTypes[(<NameNodeTransform>transform).unresolved.toLowerCase()] === 1) {
                    this.type = (<NameNodeTransform>transform).unresolved;
                } else {
                    this.type = (<NameNodeTransform>transform).name;
                }
                break;

            case undefined:
                if (transform.tokenKind === TokenKind.Callable || transform.tokenKind === TokenKind.Array) {
                    this.type = (<TokenTransform>transform).text;
                }
                break;

            default:
                break;
        }

    }

}

class IdentifierTransform implements TextNodeTransform {

    phraseKind = PhraseKind.Identifier;
    text = '';
    push(transform: NodeTransform) {
        this.text = (<TokenTransform>transform).text;
    }

}

class MethodDeclarationHeaderTransform implements NodeTransform {

    phraseKind = PhraseKind.MethodDeclarationHeader;
    modifiers = SymbolModifier.Public;
    name = '';
    parameters: PhpSymbol[];
    returnType = '';

    constructor() {
        this.parameters = [];
    }

    push(transform: NodeTransform) {
        switch (transform.phraseKind) {
            case PhraseKind.MemberModifierList:
                this.modifiers = (<MemberModifierListTransform>transform).modifiers;
                if(!(this.modifiers & (SymbolModifier.Public | SymbolModifier.Protected | SymbolModifier.Private))) {
                    this.modifiers |= SymbolModifier.Public;
                }
                break;

            case PhraseKind.Identifier:
                this.name = (<IdentifierTransform>transform).text;
                break;

            case PhraseKind.ParameterDeclarationList:
                {
                    let transforms = (<DelimiteredListTransform>transform).transforms as ParameterDeclarationTransform[];
                    for (let n = 0; n < transforms.length; ++n) {
                        this.parameters.push(transforms[n].symbol);
                    }
                }
                break;

            case PhraseKind.ReturnType:
                this.returnType = (<TypeDeclarationTransform>transform).type;
                break;

            default:
                break;
        }
    }

}

class PropertyInitialiserTransform implements NodeTransform {

    phraseKind = PhraseKind.PropertyInitialiser;
    text = '';

    push(transform: NodeTransform) {
        this.text = (<TextNodeTransform>transform).text;
    }

}

class PropertyElementTransform implements SymbolNodeTransform {

    phraseKind = PhraseKind.PropertyElement;
    symbol: PhpSymbol;
    private _doc: PhpDoc;
    private _docLocation: Location;

    constructor(public nameResolver: NameResolver, location: Location, doc: PhpDoc, docLocation: Location) {
        this.symbol = PhpSymbol.create(SymbolKind.Property, '', location);
        this._doc = doc;
        this._docLocation = docLocation;
    }

    push(transform: NodeTransform) {

        if (transform.tokenKind === TokenKind.VariableName) {
            this.symbol.name = (<TokenTransform>transform).text;
            SymbolReader.assignPhpDocInfoToSymbol(this.symbol, this._doc, this._docLocation, this.nameResolver)
        } else if (transform.phraseKind === PhraseKind.PropertyInitialiser) {
            this.symbol.value = (<PropertyInitialiserTransform>transform).text;
        }

    }

}

class FieldDeclarationTransform implements SymbolsNodeTransform {

    private _modifier = SymbolModifier.Public;
    symbols: PhpSymbol[];

    constructor(public phraseKind: PhraseKind) {
        this.symbols = [];
    }

    push(transform: NodeTransform) {
        if (transform.phraseKind === PhraseKind.MemberModifierList) {
            this._modifier = (<MemberModifierListTransform>transform).modifiers;
        } else if (
            transform.phraseKind === PhraseKind.PropertyElementList ||
            transform.phraseKind === PhraseKind.ClassConstElementList
        ) {
            let transforms = (<DelimiteredListTransform>transform).transforms as SymbolNodeTransform[];
            let s: PhpSymbol;
            for (let n = 0; n < transforms.length; ++n) {
                s = transforms[n].symbol;
                if (s) {
                    s.modifiers |= this._modifier;
                    this.symbols.push(s);
                }
            }
        }
    }

}

class FunctionDeclarationTransform implements SymbolNodeTransform {

    phraseKind = PhraseKind.FunctionDeclaration;
    private _symbol: PhpSymbol;
    private _children: UniqueSymbolCollection;

    constructor(public nameResolver: NameResolver, location: Location, phpDoc: PhpDoc, phpDocLocation: Location) {
        this._symbol = PhpSymbol.create(SymbolKind.Function, '', location);
        SymbolReader.assignPhpDocInfoToSymbol(this._symbol, phpDoc, phpDocLocation, nameResolver);
        this._children = new UniqueSymbolCollection();
    }

    push(transform: NodeTransform) {
        if (transform instanceof FunctionDeclarationHeaderTransform) {
            this._symbol.name = this.nameResolver.resolveRelative(transform.name);
            this._children.pushMany(transform.parameters);
            this._symbol.type = transform.returnType;
        } else if (transform.phraseKind === PhraseKind.FunctionDeclarationBody) {
            this._children.pushMany((<FunctionDeclarationBodyTransform>transform).symbols);
        }
    }

    get symbol() {
        this._symbol.children = PhpSymbol.setScope(this._children.toArray(), this._symbol.name);
        return this._symbol;
    }

}

class FunctionDeclarationHeaderTransform implements NodeTransform {

    phraseKind = PhraseKind.FunctionDeclarationHeader;
    name = '';
    parameters: PhpSymbol[];
    returnType = '';

    constructor() {
        this.parameters = [];
    }

    push(transform: NodeTransform) {

        if (transform.tokenKind === TokenKind.Name) {
            this.name = (<TokenTransform>transform).text;
        } else if (transform.phraseKind === PhraseKind.ParameterDeclarationList) {
            let transforms = (<DelimiteredListTransform>transform).transforms as SymbolNodeTransform[];
            for (let n = 0; n < transforms.length; ++n) {
                this.parameters.push(transforms[n].symbol);
            }
        } else if (transform.phraseKind === PhraseKind.ReturnType) {
            this.returnType = (<ReturnTypeTransform>transform).type;
        }
    }
}

class DefaultNodeTransform implements TextNodeTransform {

    constructor(public phraseKind: PhraseKind, public text: string) { }
    push(transform: NodeTransform) { }

}

export namespace SymbolReader {

    export function assignPhpDocInfoToSymbol(s: PhpSymbol, doc: PhpDoc, docLocation: Location, nameResolver: NameResolver) {

        if (!doc) {
            return s;
        }
        let tag: Tag;

        switch (s.kind) {
            case SymbolKind.Property:
            case SymbolKind.ClassConstant:
                tag = doc.findVarTag(s.name);
                if (tag) {
                    s.doc = PhpSymbolDoc.create(tag.description, TypeString.nameResolve(tag.typeString, nameResolver));
                }
                break;

            case SymbolKind.Method:
            case SymbolKind.Function:
                tag = doc.returnTag;
                s.doc = PhpSymbolDoc.create(doc.text);
                if (tag) {
                    s.doc.type = TypeString.nameResolve(tag.typeString, nameResolver);
                }
                break;

            case SymbolKind.Parameter:
                tag = doc.findParamTag(s.name);
                if (tag) {
                    s.doc = PhpSymbolDoc.create(tag.description, TypeString.nameResolve(tag.typeString, nameResolver));
                }
                break;

            case SymbolKind.Class:
            case SymbolKind.Trait:
            case SymbolKind.Interface:
                s.doc = PhpSymbolDoc.create(doc.text);
                if (!s.children) {
                    s.children = [];
                }
                Array.prototype.push.apply(s.children, phpDocMembers(doc, docLocation, nameResolver));
                break;
            
            case SymbolKind.GlobalVariable:
                tag = doc.findGlobalTag(s.name);

                if (tag) {
                    s.type = TypeString.nameResolve(tag.typeString, nameResolver);
                    s.doc = PhpSymbolDoc.create(doc.text, s.type);
                }

                break;

            default:
                break;

        }

        return s;

    }

    export function phpDocMembers(phpDoc: PhpDoc, phpDocLoc: Location, nameResolver: NameResolver) {

        let magic: Tag[] = phpDoc.propertyTags;
        let symbols: PhpSymbol[] = [];

        for (let n = 0, l = magic.length; n < l; ++n) {
            symbols.push(propertyTagToSymbol(magic[n], phpDocLoc, nameResolver));
        }

        magic = phpDoc.methodTags;
        for (let n = 0, l = magic.length; n < l; ++n) {
            symbols.push(methodTagToSymbol(magic[n], phpDocLoc, nameResolver));
        }

        return symbols;
    }

    function methodTagToSymbol(tag: Tag, phpDocLoc: Location, nameResolver: NameResolver) {

        let s = PhpSymbol.create(SymbolKind.Method, tag.name, phpDocLoc);
        s.modifiers = SymbolModifier.Magic | SymbolModifier.Public;
        s.doc = PhpSymbolDoc.create(tag.description, TypeString.nameResolve(tag.typeString, nameResolver));
        s.children = [];

        if(tag.isStatic) {
            s.modifiers |= SymbolModifier.Static;
        }

        if (!tag.parameters) {
            return s;
        }

        for (let n = 0, l = tag.parameters.length; n < l; ++n) {
            s.children.push(magicMethodParameterToSymbol(tag.parameters[n], phpDocLoc, nameResolver));
        }

        return s;
    }

    function magicMethodParameterToSymbol(p: MethodTagParam, phpDocLoc: Location, nameResolver: NameResolver) {

        let s = PhpSymbol.create(SymbolKind.Parameter, p.name, phpDocLoc);
        s.modifiers = SymbolModifier.Magic;
        s.doc = PhpSymbolDoc.create(undefined, TypeString.nameResolve(p.typeString, nameResolver));
        return s;

    }

    function propertyTagToSymbol(t: Tag, phpDocLoc: Location, nameResolver: NameResolver) {
        let s = PhpSymbol.create(SymbolKind.Property, t.name, phpDocLoc);
        s.modifiers = magicPropertyModifier(t) | SymbolModifier.Magic | SymbolModifier.Public;
        s.doc = PhpSymbolDoc.create(t.description, TypeString.nameResolve(t.typeString, nameResolver));
        return s;
    }

    function magicPropertyModifier(t: Tag) {
        switch (t.tagName) {
            case '@property-read':
                return SymbolModifier.ReadOnly;
            case '@property-write':
                return SymbolModifier.WriteOnly;
            default:
                return SymbolModifier.None;
        }
    }

    export function modifierListToSymbolModifier(phrase: Phrase) {

        if (!phrase) {
            return 0;
        }

        let flag = SymbolModifier.None;
        let tokens = phrase.children || [];

        for (let n = 0, l = tokens.length; n < l; ++n) {
            flag |= modifierTokenToSymbolModifier(<Token>tokens[n]);
        }

        return flag;
    }

    export function modifierTokenToSymbolModifier(t: Token) {
        switch (t.kind) {
            case TokenKind.Public:
                return SymbolModifier.Public;
            case TokenKind.Protected:
                return SymbolModifier.Protected;
            case TokenKind.Private:
                return SymbolModifier.Private;
            case TokenKind.Abstract:
                return SymbolModifier.Abstract;
            case TokenKind.Final:
                return SymbolModifier.Final;
            case TokenKind.Static:
                return SymbolModifier.Static;
            default:
                return SymbolModifier.None;
        }

    }

}

class NamespaceUseClauseListTransform implements SymbolsNodeTransform {

    symbols: PhpSymbol[];

    constructor(public phraseKind: PhraseKind) {
        this.symbols = [];
    }

    push(transform: NodeTransform) {
        if (
            transform.phraseKind === PhraseKind.NamespaceUseClause ||
            transform.phraseKind === PhraseKind.NamespaceUseGroupClause
        ) {
            this.symbols.push((<NamespaceUseClauseTransform>transform).symbol);
        }
    }

}

class NamespaceUseDeclarationTransform implements SymbolsNodeTransform {

    phraseKind = PhraseKind.NamespaceUseDeclaration;
    symbols: PhpSymbol[];
    private _kind = SymbolKind.Class;
    private _prefix = '';

    constructor() {
        this.symbols = [];
    }

    push(transform: NodeTransform) {
        if (transform.tokenKind === TokenKind.Const) {
            this._kind = SymbolKind.Constant;
        } else if (transform.tokenKind === TokenKind.Function) {
            this._kind = SymbolKind.Function;
        } else if (transform.phraseKind === PhraseKind.NamespaceName) {
            this._prefix = (<NamespaceNameTransform>transform).text;
        } else if (transform.phraseKind === PhraseKind.NamespaceUseGroupClauseList) {
            this.symbols = (<NamespaceUseClauseListTransform>transform).symbols;
            let s: PhpSymbol;
            let prefix = this._prefix ? this._prefix + '\\' : '';
            for (let n = 0; n < this.symbols.length; ++n) {
                s = this.symbols[n];
                s.associated[0].name = prefix + s.associated[0].name;
                if (!s.kind) {
                    s.kind = s.associated[0].kind = this._kind;
                }
            }
        } else if (transform.phraseKind === PhraseKind.NamespaceUseClauseList) {
            this.symbols = (<NamespaceUseClauseListTransform>transform).symbols;
            let s: PhpSymbol;
            for (let n = 0; n < this.symbols.length; ++n) {
                s = this.symbols[n];
                s.kind = s.associated[0].kind = this._kind;
            }
        }
    }

}

class NamespaceUseClauseTransform implements NodeTransform {

    symbol: PhpSymbol;

    constructor(public phraseKind: PhraseKind, location: Location) {
        this.symbol = PhpSymbol.create(0, '', location);
        this.symbol.modifiers = SymbolModifier.Use;
        this.symbol.associated = [];
    }

    push(transform: NodeTransform) {
        if (transform.tokenKind === TokenKind.Function) {
            this.symbol.kind = SymbolKind.Function;
        } else if (transform.tokenKind === TokenKind.Const) {
            this.symbol.kind = SymbolKind.Constant;
        } else if (transform.phraseKind === PhraseKind.NamespaceName) {
            let text = (<NamespaceNameTransform>transform).text;
            this.symbol.name = PhpSymbol.notFqn(text);
            this.symbol.associated.push(PhpSymbol.create(this.symbol.kind, text));
        } else if (transform.phraseKind === PhraseKind.NamespaceAliasingClause) {
            this.symbol.name = (<NamespaceAliasingClause>transform).text;
            this.symbol.location = (<NamespaceAliasingClause>transform).location;
        }
    }

}

class NamespaceAliasingClause implements TextNodeTransform {

    phraseKind = PhraseKind.NamespaceAliasingClause;
    text = '';
    location: Location;

    push(transform: NodeTransform) {
        if (transform.tokenKind === TokenKind.Name) {
            this.text = (<TokenTransform>transform).text;
            this.location = (<TokenTransform>transform).location;
        }
    }

}

class GlobalVariableTransform implements NodeTransform {

    symbol: PhpSymbol;

    constructor(
        private nameResolver: NameResolver,
        private globalVars: Map<string, PhpSymbol>,
        location: Location,
        private doc: PhpDoc,
        private docLocation: Location
    ) {
        this.symbol = PhpSymbol.create(SymbolKind.GlobalVariable, '', location);
        this.symbol.children = [];
        this.symbol.associated = [];
    }

    push(transform: NodeTransform) {
        if (transform instanceof SimpleVariableTransform) {
            this.symbol.name = (<SimpleVariableTransform>transform).symbol.name;
            SymbolReader.assignPhpDocInfoToSymbol(this.symbol, this.doc, this.docLocation, this.nameResolver);

            if (this.symbol.name) {
                this.globalVars.set(this.symbol.name, this.symbol);
            }
        }

    }

}

class SimpleAssignmentTransform implements NodeTransform {

    private _pushCount = 0;
    private _symbol: PhpSymbol | null = null;

    constructor(private _globalVars: Map<string, PhpSymbol>) { }

    push(transform: NodeTransform) {
        this._pushCount++;

        if (this._pushCount === 1 && transform.phraseKind == PhraseKind.SimpleVariable) {
            const varName = (<SimpleVariableTransform>transform).symbol.name;
            if (this._globalVars.has(varName)) {
                this._symbol = this._globalVars.get(varName);
            }
        } else if (this._symbol !== null) {
            if (transform.phraseKind == PhraseKind.ClassTypeDesignator) {
                this._symbol.type = TypeString.merge(
                    this._symbol.type,
                    (<TypeDesignatorTransform>transform).type
                );
            }
        }
    }
}

class TypeDesignatorTransform implements NodeTransform {

    public phraseKind = PhraseKind.ClassTypeDesignator;
    type: string = '';

    push(transform: NodeTransform) {
        switch (transform.phraseKind) {
            case PhraseKind.FullyQualifiedName:
            case PhraseKind.RelativeQualifiedName:
            case PhraseKind.QualifiedName:
                this.type = (<NameNodeTransform>transform).name;
                break;

            default:
                break;
        }
    }

}

