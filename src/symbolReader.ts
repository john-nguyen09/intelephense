/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import { TreeVisitor } from './types';
import { ParsedDocument, NodeTransform } from './parsedDocument';
import { PhpDoc, PhpDocParser, Tag, MethodTagParam } from './phpDoc';
import { PhpSymbol, SymbolKind, SymbolModifier, PhpSymbolDoc } from './symbol';
import { NameResolver } from './nameResolver';
import { TypeString } from './typeString';
import { Location } from 'vscode-languageserver';
import { SyntaxNode } from 'tree-sitter';

export class SymbolReader implements TreeVisitor<SyntaxNode> {

    lastPhpDoc: PhpDoc | null = null;
    lastPhpDocLocation: Location | null;

    private _transformStack: (NodeTransform | null)[];

    constructor(
        public document: ParsedDocument,
        public nameResolver: NameResolver
    ) {
        this._transformStack = [
            new FileTransform(this.document.uri, this.document.nodeLocation(this.document.tree.rootNode))
        ];
    }

    get symbol() {
        return (<FileTransform>this._transformStack[0]).symbol;
    }

    preorder(node: SyntaxNode, spine: SyntaxNode[]) {

        const parentNode = (spine.length ? spine[spine.length - 1] : null);
        const parentTransform = this._transformStack[this._transformStack.length - 1];

        switch (node.type) {

            case 'ERROR':
                this._transformStack.push(null);
                break;

            case 'program':
                this._transformStack.push(new ProgramTransform());
                break;

            case 'namespace_definition':
                let t = new NamespaceDefinitionTransform(this.document.nodeLocation(node));
                this._transformStack.push(t);
                this.nameResolver.namespace = t.symbol;
                break;

            case 'namespace_use_declaration':
                this._transformStack.push(new NamespaceUseDeclarationTransform());
                break;

            case 'namespace_use_clause':
            case 'namespace_use_group_clause_2':
                {
                    let t = new NamespaceUseClauseTransform(node.type, this.document.nodeLocation(node));
                    this._transformStack.push(t);
                    this.nameResolver.rules.push(t.symbol);
                    break;
                }

            case 'namespace_aliasing_clause':
                this._transformStack.push(new NamespaceAliasingClause());
                break;

            case 'namespace_function_or_const':
                this._transformStack.push(new NamespaceFunctionOrConst());
                break;

            case 'const_element':
                this._transformStack.push(new ConstElementTransform(
                    this.nameResolver,
                    this.document.nodeLocation(node),
                    this.lastPhpDoc,
                    this.lastPhpDocLocation
                ));
                break;

            case 'function_definition':
                this._transformStack.push(new FunctionDeclarationTransform(
                    this.nameResolver, this.document.nodeLocation(node), this.lastPhpDoc, this.lastPhpDocLocation
                ));
                break;

            case 'formal_parameters':
                this._transformStack.push(new DelimiteredListTransform('formal_parameters'));
                break;
            
            case 'simple_parameter':
            case 'variadic_parameter':
                this._transformStack.push(new ParameterDeclarationTransform(
                    this.document.nodeLocation(node),
                    this.lastPhpDoc,
                    this.lastPhpDocLocation,
                    this.nameResolver
                ));
                break;

            case 'type_declaration':
                this._transformStack.push(new TypeDeclarationTransform());
                break;

            case 'return_statement':
                this._transformStack.push(new ReturnTypeTransform());
                break;

            case 'compound_statement':
                if (parentNode !== null && parentNode.type === 'function_definition') {
                    this._transformStack.push(new FunctionDeclarationBodyTransform('function_declaration_body'));
                } else {
                    this._transformStack.push(null);
                }
                break;

            case 'class_declaration':
                {
                    let t = new ClassDeclarationTransform(
                        this.nameResolver, this.document.nodeLocation(node), this.lastPhpDoc, this.lastPhpDocLocation
                    );
                    this._transformStack.push(t);
                    this.nameResolver.pushClass(t.symbol);
                }
                break;

            case 'class_base_clause':
                this._transformStack.push(new ClassBaseClauseTransform());
                break;

            case 'class_interface_clause':
                this._transformStack.push(new ClassInterfaceClauseTransform());
                break;

            case 'interface_declaration':
                {
                    let t = new InterfaceDeclarationTransform(
                        this.nameResolver, this.document.nodeLocation(node), this.lastPhpDoc, this.lastPhpDocLocation
                    );
                    this._transformStack.push(t);
                    this.nameResolver.pushClass(t.symbol);
                }
                break;

            case 'interface_base_clause':
                this._transformStack.push(new InterfaceBaseClauseTransform());
                break;

            case 'trait_declaration':
                this._transformStack.push(new TraitDeclarationTransform(
                    this.nameResolver, this.document.nodeLocation(node), this.lastPhpDoc, this.lastPhpDocLocation
                ));
                break;

            case 'class_const_declaration':
                this._transformStack.push(new FieldDeclarationTransform('class_const_declaration'));
                break;

            case 'property_declaration':
                this._transformStack.push(new FieldDeclarationTransform('property_declaration'));
                break;

            case 'property_element':
                this._transformStack.push(new PropertyElementTransform(
                    this.nameResolver, this.document.nodeLocation(node), this.lastPhpDoc, this.lastPhpDocLocation
                ));
                break;

            case 'property_initializer':
                this._transformStack.push(new PropertyInitialiserTransform());
                break;

            case 'trait_use_clause':
                this._transformStack.push(new TraitUseClauseTransform());
                break;

            case 'method_declaration':
            case 'constructor_declaration':
                this._transformStack.push(new MethodDeclarationTransform(
                    this.nameResolver, this.document.nodeLocation(node), this.lastPhpDoc, this.lastPhpDocLocation
                ));
                break;

            case 'object_creation_expression':
                if (SymbolReader.isAnonymousClassDeclaration(node)) {
                    let t = new AnonymousClassDeclarationTransform(
                        this.document.nodeLocation(node), this.document.createAnonymousName(node)
                    );
                    this._transformStack.push(t);
                    this.nameResolver.pushClass(t.symbol);
                } else {
                    this._transformStack.push(null);
                }
                break;

            case 'anonymous_function_creation_expression':
                this._transformStack.push(new AnonymousFunctionCreationExpressionTransform(
                    this.document.nodeLocation(node), this.document.createAnonymousName(node)
                ));
                break;

            case 'anonymous_function_use_clause':
                this._transformStack.push(new AnonymousFunctionUseClauseTransform());
                break;

            case 'variable_name':
                if (parentNode !== null && parentNode.type === 'anonymous_function_use_clause') {
                    this._transformStack.push(new AnonymousFunctionUseVariableTransform(this.document.nodeLocation(node)));
                    break;
                } else if (parentNode !== null && parentNode.type === 'catch_clause') {
                    //catch clause vars
                    for (const transform of this._transformStack) {
                        if (!transform || typeof transform.push === 'undefined') {
                            continue;
                        }
        
                        transform.push(
                            new CatchClauseVariableNameTransform(
                                node.text,
                                this.document.nodeLocation(node)
                            )
                        );
                        break;
                    }
                }
                
                this._transformStack.push(new SimpleVariableTransform(this.document.nodeLocation(node)));
                break;

            case 'function_call_expression':
                //define
                if (node.childCount > 0) {
                    const namedChild = node.firstNamedChild;
                    if (namedChild !== null && ['define', '\\define'].includes(namedChild.text.toLowerCase())) {
                        this._transformStack.push(new DefineFunctionCallExpressionTransform(this.document.nodeLocation(node)));
                        break;
                    }
                }
                this._transformStack.push(null);
                break;

            case 'arguments':
                if (parentNode !== null && parentNode.type === 'function_call_expression' && parentTransform) {
                    this._transformStack.push(new DelimiteredListTransform('arguments'));
                } else {
                    this._transformStack.push(null);
                }
                break;

            case 'qualified_name':
                if (parentTransform) {
                    this._transformStack.push(new QualifiedNameTransform(this.nameResolver));
                } else {
                    this._transformStack.push(null);
                }
                break;

            case 'namespace_name':
                if (parentTransform) {
                    this._transformStack.push(new NamespaceNameTransform(node));
                } else {
                    this._transformStack.push(null);
                }
                break;
            
            case 'namespace_name_as_prefix':
                this._transformStack.push(new NamespaceNameAsPrefixTransform());
                break;
            
            case 'global_declaration':
                if (this.lastPhpDoc && this.lastPhpDoc.globalTags.length > 0) {
                    this._transformStack.push(new GlobalVariableTransform(
                        this.nameResolver,
                        this.document.nodeLocation(node),
                        this.lastPhpDoc,
                        this.lastPhpDocLocation
                    ));
                } else {
                    this._transformStack.push(null);
                }
                break;

            case 'visibility_modifier':
                this._transformStack.push(new VisibilityModifier());
                break;
            
            case 'static_modifier':
                this._transformStack.push(new StaticModifier());
                break;

            case 'class_modifier':
                this._transformStack.push(new ClassModifier());
                break;

            case 'comment':
                this.lastPhpDoc = PhpDocParser.parse(node.text);
                this.lastPhpDocLocation = this.document.nodeLocation(node);
                this._transformStack.push(null);

                break;
            
            case '}':
                this.lastPhpDoc = null;
                this.lastPhpDocLocation = null;
                this._transformStack.push(null);

                break;

            case 'text':
                return true;

            default:

                if (
                    parentNode !== null &&
                    parentTransform !== null
                ) {
                    this._transformStack.push(new DefaultNodeTransform(node, this.document));
                } else {
                    this._transformStack.push(null);
                }
                break;
        }

        return true;

    }

    postorder(node: SyntaxNode, spine: SyntaxNode[]) {
        if (node.type === 'text') {
            return;
        }

        const transform = this._transformStack.pop();

        if (!transform) {
            return;
        }

        for (let i = this._transformStack.length - 1; i >= 0; i--) {
            const parentTransform = this._transformStack[i];
            if (parentTransform && typeof parentTransform.push !== 'undefined') {
                parentTransform.push(transform);
                break;
            }
        }

        if (node.type === 'object_creation_expression') {
            if (SymbolReader.isAnonymousClassDeclaration(node)) {
                this.lastPhpDoc = null;
                this.lastPhpDocLocation = null;
            }
        } else {
            switch (node.type) {
                case 'class_declaration':
                case 'interface_declaration':
                case 'function_declaration':
                case 'trait_declaration':
                case 'global_declaration':
                    this.lastPhpDoc = null;
                    this.lastPhpDocLocation = null;
                    break;
            }
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
    name: string;
}

interface SymbolsNodeTransform extends NodeTransform {
    symbols: PhpSymbol[];
}

class FileTransform implements SymbolNodeTransform {

    kind = 'file';
    private _children: UniqueSymbolCollection;
    private _symbol: PhpSymbol;

    constructor(uri: string, location: Location) {
        this._symbol = PhpSymbol.create(SymbolKind.File, uri, location);
        this._children = new UniqueSymbolCollection();
    }

    push(transform: NodeTransform) {
        if (transform instanceof ProgramTransform) {
            this._children.pushMany(transform.symbols);
        }
    }

    get symbol() {
        this._symbol.children = this._children.toArray();
        return this._symbol;
    }

}

class ProgramTransform implements SymbolsNodeTransform {
    kind = 'program';
    private _children: UniqueSymbolCollection = new UniqueSymbolCollection();

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

    get symbols() {
        return this._children.toArray();
    }
}

class DelimiteredListTransform implements NodeTransform {

    transforms: NodeTransform[];

    constructor(public kind: string) {
        this.transforms = [];
    }

    push(transform: NodeTransform) {
        if (
            transform.kind === '(' ||
            transform.kind === ',' ||
            transform.kind === ')'
        ) {
            return;
        }

        this.transforms.push(transform);
    }

}

class NamespaceNameTransform implements TextNodeTransform {

    kind = 'namespace_name';
    private _parts: string[];

    constructor(node: SyntaxNode) {
        this._parts = [];
        for (const child of node.children) {
            if (child.type === 'name') {
                this._parts.push(child.text);
            }
        }
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'namespace_name_as_prefix') {
            this._parts.push((<NamespaceNameAsPrefixTransform>transform).name);
        } else if (transform.kind === 'name') {
            this._parts.push((<DefaultNodeTransform>transform).name);
        }
    }

    get name() {
        return this._parts.join('\\');
    }

}

class NamespaceNameAsPrefixTransform implements TextNodeTransform {

    kind = 'namespace_name_as_prefix';
    name: string;

    push(transform: NodeTransform) {
        if (transform.kind === 'namespace_name') {
            this.name = (<NamespaceNameTransform>transform).name;
        }
    }

}

class QualifiedNameTransform implements NameNodeTransform {

    kind = 'qualified_name';
    name = '';
    unresolved = '';
    constructor(public nameResolver: NameResolver) {

    }

    push(transform: NodeTransform) {
        if (transform.kind === 'namespace_name') {
            this.unresolved = (<NamespaceNameTransform>transform).name;
            this.name = this.nameResolver.resolveNotFullyQualified(this.unresolved);
        } else if (transform.kind === 'name') {
            this.unresolved = (<DefaultNodeTransform>transform).name;
            this.name = this.nameResolver.resolveNotFullyQualified(this.unresolved);
        }
    }

}

class CatchClauseVariableNameTransform implements SymbolNodeTransform {
    kind = 'variable_name';
    symbol: PhpSymbol;
    constructor(name: string, location: Location) {
        this.symbol = PhpSymbol.create(SymbolKind.Variable, name, location);
    }

    push(transform: NodeTransform) { }
}

class ParameterDeclarationTransform implements SymbolNodeTransform {

    kind = 'parameter_declaration';
    symbol: PhpSymbol;
    private _doc: PhpDoc | null;
    private _nameResolver: NameResolver;
    private _docLocation: Location | null;

    constructor(location: Location, doc: PhpDoc | null, docLocation: Location | null, nameResolver: NameResolver) {
        this.symbol = PhpSymbol.create(SymbolKind.Parameter, '', location);
        this._doc = doc;
        this._docLocation = docLocation;
        this._nameResolver = nameResolver;
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'type_declaration') {
            this.symbol.type = (<TypeDeclarationTransform>transform).kind;
        } else if (transform.kind === '&') {
            this.symbol.modifiers = SymbolModifier.Reference;
        } else if (transform.kind === '...') {
            this.symbol.modifiers = SymbolModifier.Variadic;
        } else if (transform.kind === 'variable_name') {
            this.symbol.name = (<SimpleVariableTransform>transform).symbol.name;
            SymbolReader.assignPhpDocInfoToSymbol(this.symbol, this._doc, this._docLocation, this._nameResolver);
        } else {
            this.symbol.value = (<TextNodeTransform>transform).name;
        }
    }

}

class DefineFunctionCallExpressionTransform implements SymbolNodeTransform {

    kind = 'function_call_expression';
    symbol: PhpSymbol;
    constructor(location: Location) {
        this.symbol = PhpSymbol.create(SymbolKind.Constant, '', location);
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'arguments') {
            const [arg1, arg2] = (<DelimiteredListTransform>transform).transforms as TextNodeTransform[];

            if (arg1 && arg1.kind === 'string') {
                this.symbol.name = arg1.name.slice(1, -1); //remove quotes
            }

            //todo --this could be an array or constant too
            if (arg2 && (arg2.kind === 'float' ||
                arg2.kind === 'integer' ||
                arg2.kind === 'string')) {
                this.symbol.value = arg2.name;
            }

            if (this.symbol.name && this.symbol.name[0] === '\\') {
                this.symbol.name = this.symbol.name.slice(1);
            }
        }
    }

}

class SimpleVariableTransform implements SymbolNodeTransform {

    kind = 'variable_name';
    symbol: PhpSymbol;
    constructor(location: Location) {
        this.symbol = PhpSymbol.create(SymbolKind.Variable, '', location);
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'name') {
            this.symbol.name = '$' + (<DefaultNodeTransform>transform).name;
        }
    }

}

class AnonymousClassDeclarationTransform implements SymbolNodeTransform {

    kind = 'object_creation_expression';
    symbol: PhpSymbol;

    constructor(location: Location, name: string) {
        this.symbol = PhpSymbol.create(SymbolKind.Class, name, location);
        this.symbol.modifiers = SymbolModifier.Anonymous;
        this.symbol.children = [];
        this.symbol.associated = [];
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'class_base_clause') {
            this.pushAssociated((<ClassBaseClauseTransform>transform).symbol);
        } else if (transform.kind === 'class_interface_clause') {
            const interfacesTransform = <ClassInterfaceClauseTransform>transform;

            for (const symbol of interfacesTransform.symbols) {
                this.pushAssociated(symbol);
            }
        } else if (
            transform.kind === 'property_declaration' || 
            transform.kind === 'class_const_declaration'
        ) {
            Array.prototype.push.apply(this.symbol.children, (<FieldDeclarationTransform>transform).symbols);
        } else if (transform.kind === 'method_declaration') {
            if (this.symbol.children) {
                this.symbol.children.push((<MethodDeclarationTransform>transform).symbol);
            }
        } else if (transform.kind === 'trait_use_clause') {
            const traitsUseTransform = <TraitUseClauseTransform>transform;

            for (const symbol of traitsUseTransform.symbols) {
                this.pushAssociated(symbol);
            }
        }
    }

    pushAssociated(associated: PhpSymbol) {
        (<PhpSymbol[]>this.symbol.associated).push(associated);
    }

}

class AnonymousFunctionCreationExpressionTransform implements SymbolNodeTransform {

    kind = 'anonymous_function_creation_expression';
    private _symbol: PhpSymbol;
    private _children: UniqueSymbolCollection;

    constructor(location: Location, name: string) {
        this._symbol = PhpSymbol.create(SymbolKind.Function, name, location);
        this._symbol.modifiers = SymbolModifier.Anonymous;
        this._children = new UniqueSymbolCollection();
    }

    push(transform: NodeTransform) {
        if (transform.kind === '&') {
            this.addModifier(SymbolModifier.Reference);
        } else if (transform.kind === 'static') {
            this.addModifier(SymbolModifier.Static);
        } else if (transform.kind === 'formal_parameters') {
            const transforms = (<DelimiteredListTransform>transform).transforms as SymbolNodeTransform[];
            for (let n = 0; n < transforms.length; ++n) {
                this._children.push(transforms[n].symbol);
            }
        } else if (transform.kind === 'anonymous_function_use_clause') {
            let symbols = (<AnonymousFunctionUseClauseTransform>transform).symbols;
            for (let n = 0; n < symbols.length; ++n) {
                this._children.push(symbols[n]);
            }
        } else if (transform.kind === 'return_statement') {
            this._symbol.type = (<ReturnTypeTransform>transform).kind;
        } else if (transform.kind === 'function_declaration_body') {
            this._children.pushMany((<FunctionDeclarationBodyTransform>transform).symbols);
        }
    }

    get symbol() {
        this._symbol.children = PhpSymbol.setScope(this._children.toArray(), this._symbol.name);
        return this._symbol;
    }

    private addModifier(modifier: SymbolModifier) {
        // We know definitely this is not undefined, but TS cannot type-check this
        (<SymbolModifier>this._symbol.modifiers) |= modifier;
    }

}

class FunctionDeclarationBodyTransform implements SymbolsNodeTransform {

    private _value: UniqueSymbolCollection;

    constructor(public kind: string) {
        this._value = new UniqueSymbolCollection();
    }

    push(transform: NodeTransform) {

        switch (transform.kind) {
            case 'variable_name':
            case 'anonymous_function_creation_expression':
            case 'anonymous_class_declaration':
            case 'function_call_expression': //define
                this._value.push((<SymbolNodeTransform>transform).symbol);
                break;
        }

    }

    get symbols() {
        return this._value.toArray();
    }

}

class AnonymousFunctionUseClauseTransform implements SymbolsNodeTransform {

    kind = 'anonymous_function_use_clause';
    symbols: PhpSymbol[];

    constructor() {
        this.symbols = [];
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'variable_name') {
            this.symbols.push((<AnonymousFunctionUseVariableTransform>transform).symbol);
        }
    }

}

class AnonymousFunctionUseVariableTransform implements SymbolNodeTransform {

    kind = 'variable_name';
    symbol: PhpSymbol;

    constructor(location: Location) {
        this.symbol = PhpSymbol.create(SymbolKind.Variable, '', location);
        this.symbol.modifiers = SymbolModifier.Use;
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'name') {
            this.symbol.name = (<DefaultNodeTransform>transform).name;
        } else if (transform.kind === '&') {
            this.symbol.modifiers = SymbolModifier.Reference;
        }
    }

}

class InterfaceDeclarationTransform implements SymbolNodeTransform {

    kind = 'interface_declaration';
    symbol: PhpSymbol;

    constructor(
        public nameResolver: NameResolver,
        location: Location,
        doc: PhpDoc | null,
        docLocation: Location | null
    ) {
        this.symbol = PhpSymbol.create(SymbolKind.Interface, '', location);
        SymbolReader.assignPhpDocInfoToSymbol(this.symbol, doc, docLocation, nameResolver);
        this.symbol.children = [];
        this.symbol.associated = [];
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'name') {
            this.symbol.name = this.nameResolver.resolveRelative((<DefaultNodeTransform>transform).name);
        } else if (transform.kind === 'interface_base_clause') {
            this.symbol.associated = (<InterfaceBaseClauseTransform>transform).symbols;
        } else if (transform.kind === 'method_declaration') {
            this.pushChild((<MethodDeclarationTransform>transform).symbol);
        } else if (transform.kind === 'class_const_declaration') {
            for (const symbol of (<FieldDeclarationTransform>transform).symbols) {
                this.pushChild(symbol);
            }
        }
    }

    pushChild(child: PhpSymbol) {
        PhpSymbol.setScope([child], this.symbol.name);
        (<PhpSymbol[]>this.symbol.children).push(child);
    }
}

class ConstElementTransform implements SymbolNodeTransform {

    kind = 'const_element';
    symbol: PhpSymbol;

    constructor(
        public nameResolver: NameResolver,
        location: Location,
        private _doc: PhpDoc | null,
        private _docLocation: Location | null
    ) {
        this.symbol = PhpSymbol.create(SymbolKind.Constant, '', location);
        this.symbol.scope = this.nameResolver.namespaceName;
    }

    push(transform: NodeTransform) {

        if (transform.kind === 'name') {
            this.symbol.name = this.nameResolver.resolveRelative((<DefaultNodeTransform>transform).name);
            SymbolReader.assignPhpDocInfoToSymbol(this.symbol, this._doc, this._docLocation, this.nameResolver);
        } else {
            //expression
            this.symbol.value = (<TextNodeTransform>transform).name;
        }

    }

}

class TraitDeclarationTransform implements SymbolNodeTransform {

    kind = 'trait_declaration';
    symbol: PhpSymbol;

    constructor(
        public nameResolver: NameResolver,
        location: Location,
        doc: PhpDoc | null,
        docLocation: Location | null
    ) {
        this.symbol = PhpSymbol.create(SymbolKind.Trait, '', location);
        SymbolReader.assignPhpDocInfoToSymbol(this.symbol, doc, docLocation, nameResolver);
        this.symbol.children = [];
        this.symbol.associated = [];
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'name') {
            this.symbol.name = this.nameResolver.resolveRelative((<DefaultNodeTransform>transform).name);
        } else if (transform.kind === 'property_declaration') {
            for (const symbol of (<FieldDeclarationTransform>transform).symbols) {
                this.pushChild(symbol);
            }
        } else if (transform.kind === 'method_declaration') {
            this.pushChild((<MethodDeclarationTransform>transform).symbol);
        } else if (transform.kind === 'trait_use_clause') {
            for (const symbol of (<TraitUseClauseTransform>transform).symbols) {
                this.pushAssociated(symbol);
            }
        }
    }

    pushAssociated(associated: PhpSymbol) {
        (<PhpSymbol[]>this.symbol.associated).push(associated);
    }

    pushChild(child: PhpSymbol) {
        PhpSymbol.setScope([child], this.symbol.name);
        (<PhpSymbol[]>this.symbol.children).push(child);
    }

}

class InterfaceBaseClauseTransform implements SymbolsNodeTransform {
    kind = 'interface_base_clause';
    symbols: PhpSymbol[];

    constructor() {
        this.symbols = [];
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'qualified_name') {
            this.symbols.push(PhpSymbol.create(
                SymbolKind.Interface,
                (<QualifiedNameTransform>transform).name
            ));
        }
    }

}

class TraitUseClauseTransform implements SymbolsNodeTransform {

    kind = 'trait_use_clause';
    symbols: PhpSymbol[];

    constructor() {
        this.symbols = [];
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'qualified_name') {
            this.symbols.push(PhpSymbol.create(
                SymbolKind.Trait,
                (<QualifiedNameTransform>transform).name
            ));
        }
    }

}

class ClassInterfaceClauseTransform implements SymbolsNodeTransform {
    kind = 'class_interface_clause';
    symbols: PhpSymbol[];

    constructor() {
        this.symbols = [];
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'qualified_name') {
            this.symbols.push(PhpSymbol.create(
                SymbolKind.Interface,
                (<QualifiedNameTransform>transform).name
            ));
        }
    }
}

class NamespaceDefinitionTransform implements SymbolNodeTransform {

    kind = 'namespace_definition';
    private _symbol: PhpSymbol;
    private _children: UniqueSymbolCollection;

    constructor(location: Location) {
        this._symbol = PhpSymbol.create(SymbolKind.Namespace, '', location);
        this._children = new UniqueSymbolCollection();
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'namespace_name') {
            this._symbol.name = (<NamespaceNameTransform>transform).name;
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

    kind = 'class_declaration';
    symbol: PhpSymbol;
    private _gotOpen = false;

    constructor(
        public nameResolver: NameResolver,
        location: Location,
        doc: PhpDoc | null,
        docLocation: Location | null
    ) {
        this.symbol = PhpSymbol.create(SymbolKind.Class, '', location);
        this.symbol.children = [];
        this.symbol.associated = [];
        this.symbol.modifiers = SymbolModifier.None;
        SymbolReader.assignPhpDocInfoToSymbol(this.symbol, doc, docLocation, nameResolver);
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'static_modifier') {
            this.addModifier((<StaticModifier>transform).modifiers);
        } else if (!this._gotOpen && transform.kind === 'name') {
            this.symbol.name = this.nameResolver.resolveRelative((<DefaultNodeTransform>transform).name);
        } else if (transform.kind === 'class_base_clause') {
            const symbol = (<ClassBaseClauseTransform>transform).symbol;
            this.pushAssociated(symbol);
        } else if (transform.kind === 'class_interface_clause') {
            for (const symbol of (<ClassInterfaceClauseTransform>transform).symbols) {
                this.pushAssociated(symbol);
            }
        } else if (
            transform.kind === 'class_const_declaration' ||
            transform.kind === 'property_declaration'
        ) {
            for (const symbol of (<FieldDeclarationTransform>transform).symbols) {
                this.pushChild(symbol);
            }
        } else if (transform.kind === 'method_declaration') {
            this.pushChild((<MethodDeclarationTransform>transform).symbol);
        } else if (transform.kind === 'trait_use_clause') {
            for (const symbol of (<TraitUseClauseTransform>transform).symbols) {
                this.pushAssociated(symbol);
            }
        } else if (transform.kind === '{') {
            this._gotOpen = true;
        }

    }

    private addModifier(modifier: SymbolModifier) {
        (<SymbolModifier>this.symbol.modifiers) |= modifier;
    }

    private pushAssociated(associated: PhpSymbol) {
        (<PhpSymbol[]>this.symbol.associated).push(associated);
    }

    private pushChild(child: PhpSymbol) {
        PhpSymbol.setScope([child], this.symbol.name);
        (<PhpSymbol[]>this.symbol.children).push(child);
    }

}

class ClassBaseClauseTransform implements SymbolNodeTransform {

    kind = 'class_base_clause';
    symbol: PhpSymbol;

    constructor() {
        this.symbol = PhpSymbol.create(SymbolKind.Class, '');
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'qualified_name') {
            this.symbol.name = (<QualifiedNameTransform>transform).name;
        }
    }

}

class VisibilityModifier implements NodeTransform {
    kind = 'visibility_modifier';
    public modifiers: SymbolModifier;

    constructor() {
        this.modifiers = SymbolModifier.Public;
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'public') {
            this.modifiers = SymbolModifier.Public;
        } else if (transform.kind === 'protected') {
            this.modifiers = SymbolModifier.Protected;
        } else if (transform.kind === 'private') {
            this.modifiers = SymbolModifier.Private;
        }
    }
}

class StaticModifier implements NodeTransform {
    kind = 'static_modifier';
    public modifiers: SymbolModifier;

    constructor() {
        this.modifiers = SymbolModifier.None;
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'static') {
            this.modifiers = SymbolModifier.Static;
        }
    }
}

class ClassModifier implements NodeTransform {
    kind = 'class_modifier';
    public modifiers: SymbolModifier;

    constructor() {
        this.modifiers = SymbolModifier.None;
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'abstract') {
            this.modifiers |= SymbolModifier.Abstract;
        } else if (transform.kind === 'final') {
            this.modifiers |= SymbolModifier.Final;
        }
    }
}

class MethodDeclarationTransform implements SymbolNodeTransform {

    kind = 'method_declaration';
    private _symbol: PhpSymbol;

    constructor(
        public nameResolver: NameResolver,
        location: Location,
        doc: PhpDoc | null,
        docLocation: Location | null
    ) {
        this._symbol = PhpSymbol.create(SymbolKind.Method, '', location);
        SymbolReader.assignPhpDocInfoToSymbol(this._symbol, doc, docLocation, nameResolver);
        this._symbol.modifiers = SymbolModifier.None;
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'visibility_modifier') {
            this.addModifier((<VisibilityModifier>transform).modifiers);
        } else if (transform.kind === 'static_modifier') {
            this.addModifier((<StaticModifier>transform).modifiers);
        } else if (transform.kind === 'class_modifier') {
            this.addModifier((<ClassModifier>transform).modifiers);
        } else if (transform.kind === 'function_definition') {
            const functionTransform = <FunctionDeclarationTransform>transform;
            this._symbol.name = functionTransform.symbol.name;
            this._symbol.children = functionTransform.symbol.children;
            this._symbol.type = functionTransform.symbol.type;
        } else if (transform.kind === '__construct') {
            this._symbol.name = '__construct';
        } else if (transform.kind === 'name') {
            // Interfaces methods will not have function_definition
            this._symbol.name = (<DefaultNodeTransform>transform).name;
        }

    }

    get symbol() {
        return this._symbol;
    }

    private addModifier(modifier: SymbolModifier) {
        (<SymbolModifier>this._symbol.modifiers) |= modifier;
    }

}

class ReturnTypeTransform implements NodeTransform {

    kind = 'return_statement';
    returnType = '';

    push(transform: NodeTransform) {
        if (transform.kind === 'qualified_name') {
            this.returnType = (<QualifiedNameTransform>transform).name;
        }
    }

}

class TypeDeclarationTransform implements NodeTransform {

    kind = 'type_declaration';
    returnType = '';
    private static _scalarTypes: { [name: string]: number } = {
        'int': 1, 'string': 1, 'bool': 1, 'float': 1, 'iterable': 1
    };

    push(transform: NodeTransform) {
        if (transform.kind === 'qualified_name') {
            const qualifiedName = <QualifiedNameTransform>transform;

            if (TypeDeclarationTransform._scalarTypes[qualifiedName.unresolved.toLowerCase()] === 1) {
                this.returnType = qualifiedName.unresolved;
            } else {
                this.returnType = qualifiedName.name;
            }
        }

    }

}

class PropertyInitialiserTransform implements NodeTransform {

    kind = 'property_initializer';
    text = '';

    push(transform: NodeTransform) {
        if (
            transform.kind === 'string' ||
            transform.kind === 'integer' ||
            transform.kind === 'float'
        ) {
            this.text = (<DefaultNodeTransform>transform).name;
        } else if (transform.kind === 'qualified_name') {
            this.text = (<QualifiedNameTransform>transform).name;
        }
    }

}

class PropertyElementTransform implements SymbolNodeTransform {

    kind = 'property_element';
    symbol: PhpSymbol;

    constructor(
        public nameResolver: NameResolver,
        location: Location,
        private _doc: PhpDoc | null,
        private _docLocation: Location | null
    ) {
        this.symbol = PhpSymbol.create(SymbolKind.Property, '', location);
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'variable_name') {
            this.symbol.name = (<SimpleVariableTransform>transform).symbol.name;
            SymbolReader.assignPhpDocInfoToSymbol(
                this.symbol, this._doc, this._docLocation, this.nameResolver
            );
        } else if (transform.kind === 'property_initializer') {
            this.symbol.value = (<PropertyInitialiserTransform>transform).text;
        }

    }

}

class FieldDeclarationTransform implements SymbolsNodeTransform {

    private _modifier = SymbolModifier.Public;
    symbols: PhpSymbol[];

    constructor(public kind: 'class_const_declaration' | 'property_declaration') {
        this.symbols = [];
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'visibility_modifier') {
            this._modifier |= (<VisibilityModifier>transform).modifiers;
        }
        if (this.kind === 'property_declaration') {
            this._modifier |= (<StaticModifier>transform).modifiers;
        }

        if (
            transform.kind === 'property_element' ||
            transform.kind === 'const_element'
        ) {
            this.symbols.push((<SymbolNodeTransform>transform).symbol);
        }
    }

}

class FunctionDeclarationTransform implements SymbolNodeTransform {

    kind = 'function_definition';
    private _symbol: PhpSymbol;
    private _children: UniqueSymbolCollection;

    constructor(
        public nameResolver: NameResolver,
        location: Location,
        phpDoc: PhpDoc | null,
        phpDocLocation: Location | null
    ) {
        this._symbol = PhpSymbol.create(SymbolKind.Function, '', location);
        SymbolReader.assignPhpDocInfoToSymbol(this._symbol, phpDoc, phpDocLocation, nameResolver);
        this._children = new UniqueSymbolCollection();
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'name') {
            this._symbol.name = this.nameResolver.resolveRelative((<DefaultNodeTransform>transform).name);
        } else if (transform.kind === 'formal_parameters') {
            const transforms = (<DelimiteredListTransform>transform).transforms;
            const symbols = transforms.filter(transform => {
                return transform.kind === 'simple_parameter' ||
                    transform.kind === 'variadic_parameter'
            }).map(transform => {
                return (<ParameterDeclarationTransform>transform).symbol;
            });
            this._children.pushMany(symbols);
        } else if (transform.kind === 'function_declaration_body') {
            const functionBody = <FunctionDeclarationBodyTransform>transform;

            this._children.pushMany(functionBody.symbols);
        }
    }

    get symbol() {
        this._symbol.children = PhpSymbol.setScope(this._children.toArray(), this._symbol.name);
        return this._symbol;
    }

}

class DefaultNodeTransform implements TextNodeTransform {

    constructor(public node: SyntaxNode, private doc: ParsedDocument) { }

    get kind(): string {
        return this.node.type;
    }

    get name(): string {
        return this.node.text;
    }

    get location(): Location {
        return this.doc.nodeLocation(this.node);
    }

}

export namespace SymbolReader {

    export function assignPhpDocInfoToSymbol(
        s: PhpSymbol,
        doc: PhpDoc | null,
        docLocation: Location | null,
        nameResolver: NameResolver
    ) {

        if (!doc || !docLocation) {
            return s;
        }
        let tag: Tag | undefined;

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

    export function isAnonymousClassDeclaration(node: SyntaxNode) {
        if (node.type !== 'object_creation_expression') {
            return false;
        }

        const namedChild = node.child(1);
        
        return namedChild !== null && namedChild.text === 'class';
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

    export function modifierListToSymbolModifier(node: SyntaxNode) {

        if (!node) {
            return 0;
        }

        let flag = SymbolModifier.None;

        for (const child of node.children) {
            flag |= modifierNodeToSymbolModifier(child);
        }

        return flag;
    }

    export function modifierNodeToSymbolModifier(node: SyntaxNode) {
        switch (node.type) {
            case 'public':
                return SymbolModifier.Public;
            case 'protected':
                return SymbolModifier.Protected;
            case 'private':
                return SymbolModifier.Private;
            case 'abstract':
                return SymbolModifier.Abstract;
            case 'final':
                return SymbolModifier.Final;
            case 'static':
                return SymbolModifier.Static;
            default:
                return SymbolModifier.None;
        }

    }

}

class NamespaceFunctionOrConst implements NodeTransform {
    kind = 'namespace_function_or_const';
    namespaceType: 'function' | 'const' | null = null;

    push(transform: NodeTransform) {
        if (transform.kind === 'const') {
            this.namespaceType = 'const';
        } else if (transform.kind === 'function') {
            this.namespaceType = 'function';
        }
    }
}

class NamespaceUseDeclarationTransform implements SymbolsNodeTransform {

    kind = 'namespace_use_declaration';
    symbols: PhpSymbol[];
    private _kind = SymbolKind.Class;
    private _prefix = '';

    constructor() {
        this.symbols = [];
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'namespace_function_or_const') {
            const kindTransform = <NamespaceFunctionOrConst>transform;

            if (kindTransform.namespaceType === 'const') {
                this._kind = SymbolKind.Constant;
            } else if (kindTransform.namespaceType === 'function') {
                this._kind = SymbolKind.Function;
            }
        } else if (transform.kind === 'namespace_use_clause') {
            const symbol = (<NamespaceUseClauseTransform>transform).symbol;
            const prefix = this._prefix ? this._prefix + '\\' : '';

            if (symbol.associated && symbol.associated[0]) {
                symbol.associated[0].name = prefix + symbol.associated[0].name;
            }
            if (!symbol.kind) {
                symbol.kind = this._kind;
                
                if (symbol.associated && symbol.associated[0]) {
                    symbol.associated[0].kind = this._kind;
                }
            }
            this.symbols.push(symbol);
        } else if (transform.kind === 'namespace_name') {
            this._prefix = (<NamespaceNameTransform>transform).name;
        }
    }

}

class NamespaceUseClauseTransform implements NodeTransform {

    symbol: PhpSymbol;

    constructor(public kind: 'namespace_use_clause' | 'namespace_use_group_clause_2', location: Location) {
        this.symbol = PhpSymbol.create(0, '', location);
        this.symbol.modifiers = SymbolModifier.Use;
        this.symbol.associated = [];
    }

    push(transform: NodeTransform) {
        if (transform.kind === 'namespace_function_or_const') {
            const kindTransform = <NamespaceFunctionOrConst>transform;

            if (kindTransform.namespaceType === 'const') {
                this.symbol.kind = SymbolKind.Constant;
            } else if (kindTransform.namespaceType === 'function') {
                this.symbol.kind = SymbolKind.Function;
            }
        } else if (transform.kind === 'namespace_name') {
            const text = (<NamespaceNameTransform>transform).name;
            this.symbol.name = PhpSymbol.notFqn(text);
            this.pushAssociated(PhpSymbol.create(this.symbol.kind, text));
        } else if (transform.kind === 'namespace_aliasing_clause') {
            this.symbol.name = (<NamespaceAliasingClause>transform).name;
            this.symbol.location = (<NamespaceAliasingClause>transform).location;
        }
    }

    private pushAssociated(associated: PhpSymbol) {
        (<PhpSymbol[]>this.symbol.associated).push(associated);
    }

}

class NamespaceAliasingClause implements TextNodeTransform {

    kind = 'namespace_aliasing_clause';
    name = '';
    location: Location;

    push(transform: NodeTransform) {
        if (transform.kind === 'name') {
            this.name = (<DefaultNodeTransform>transform).name;
            this.location = (<DefaultNodeTransform>transform).location;
        }
    }

}

class GlobalVariableTransform implements NodeTransform {

    kind = 'global_variable';
    symbol: PhpSymbol;

    constructor(
        private nameResolver: NameResolver,
        location: Location,
        private doc: PhpDoc | null,
        private docLocation: Location | null
    ) {
        this.symbol = PhpSymbol.create(SymbolKind.GlobalVariable, '', location);
        this.symbol.children = [];
        this.symbol.associated = [];
    }

    push(transform: NodeTransform) {
        if (transform instanceof SimpleVariableTransform) {
            this.symbol.name = (<SimpleVariableTransform>transform).symbol.name;
            SymbolReader.assignPhpDocInfoToSymbol(this.symbol, this.doc, this.docLocation, this.nameResolver);
        }

    }

}

