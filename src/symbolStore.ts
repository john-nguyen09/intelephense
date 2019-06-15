/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import { PhpSymbol, SymbolKind, SymbolModifier, SymbolIdentifier } from './symbol';
import { Reference } from './reference';
import { TreeTraverser, Predicate, TreeVisitor, Traversable, BinarySearch, NameIndex } from './types';
import { Position, Location, Range } from 'vscode-languageserver-types';
import { TypeString } from './typeString';
import * as builtInSymbols from './builtInSymbols.json';
import { ParsedDocument, ParsedDocumentChangeEventArgs } from './parsedDocument';
import { SymbolReader } from './symbolReader';
import { NameResolver } from './nameResolver';
import * as util from './util';
import { TypeAggregate, MemberMergeStrategy } from './typeAggregate';
import { SymbolIndex } from './indexes/symbolIndex';
import { SymbolTableIndex } from './indexes/symbolTableIndex';
import { LevelUp } from 'levelup';

export const BUILTIN_SYMBOLS_URI = 'php://built-in';

export class SymbolTable implements Traversable<PhpSymbol> {

    private _uri: string;
    private _root: PhpSymbol;

    constructor(uri: string, root: PhpSymbol) {
        this._uri = uri;
        this._root = root;
    }

    get uri() {
        return this._uri;
    }

    get root() {
        return this._root;
    }

    get symbols() {
        let traverser = new TreeTraverser([this.root]);
        let symbols = traverser.toArray();
        //remove root
        symbols.shift();
        return symbols;
    }

    get symbolCount() {
        let traverser = new TreeTraverser([this.root]);
        //subtract 1 for root
        return traverser.count() - 1;
    }

    pruneScopedVars() {
        let visitor = new ScopedVariablePruneVisitor();
        this.traverse(visitor);
    }

    parent(s: PhpSymbol) {
        let traverser = new TreeTraverser([this.root]);
        let fn = (x: PhpSymbol) => {
            return x === s;
        };
        if (!traverser.find(fn)) {
            return null;
        }

        return traverser.parent();
    }

    traverse(visitor: TreeVisitor<PhpSymbol>) {
        let traverser = new TreeTraverser([this.root]);
        traverser.traverse(visitor);
        return visitor;
    }

    createTraverser() {
        return new TreeTraverser([this.root]);
    }

    filter(predicate: Predicate<PhpSymbol>) {
        let traverser = new TreeTraverser([this.root]);
        return traverser.filter(predicate)
    }

    find(predicate: Predicate<PhpSymbol>) {
        let traverser = new TreeTraverser([this.root]);
        return traverser.find(predicate);
    }

    nameResolver(pos: Position) {
        let nameResolver = new NameResolver();
        let traverser = new TreeTraverser([this.root]);
        let visitor = new NameResolverVisitor(pos, nameResolver);
        traverser.traverse(visitor);
        return nameResolver;
    }

    scope(pos: Position) {
        let traverser = new TreeTraverser([this.root]);
        let visitor = new ScopeVisitor(pos, false);
        traverser.traverse(visitor);
        return visitor.scope;
    }

    absoluteScope(pos: Position) {
        let traverser = new TreeTraverser([this.root]);
        let visitor = new ScopeVisitor(pos, true);
        traverser.traverse(visitor);
        return visitor.scope;
    }

    scopeSymbols() {
        return this.filter(this._isScopeSymbol);
    }

    symbolAtPosition(position: Position) {

        let pred = (x: PhpSymbol) => {
            return x.location && util.positionEquality(x.location.range.start, position);
        };

        return this.filter(pred).pop();
    }

    contains(s: PhpSymbol) {
        let traverser = new TreeTraverser([this.root]);
        let visitor = new ContainsVisitor(s);
        traverser.traverse(visitor);
        return visitor.found;
    }

    private _isScopeSymbol(s: PhpSymbol) {
        const mask = SymbolKind.Class | SymbolKind.Interface | SymbolKind.Trait | SymbolKind.None | SymbolKind.Function | SymbolKind.Method;
        return (s.kind & mask) > 0;
    }

    toJSON() {
        return {
            _uri: this._uri,
            _root: this._root,
        };
    }

    static fromJSON(data: any) {
        return new SymbolTable(data._uri, data._root);
    }

    static create(parsedDocument: ParsedDocument, externalOnly?: boolean) {

        let symbolReader = new SymbolReader(parsedDocument, new NameResolver());

        parsedDocument.traverse(symbolReader);
        return new SymbolTable(
            parsedDocument.uri,
            symbolReader.symbol
        );

    }

    static readBuiltInSymbols() {

        return new SymbolTable(BUILTIN_SYMBOLS_URI, {
            kind: SymbolKind.None,
            name: '',
            children: <any>builtInSymbols
        });

    }

}

class ScopedVariablePruneVisitor implements TreeVisitor<PhpSymbol> {

    preorder(node: PhpSymbol, spine: PhpSymbol[]) {

        if ((node.kind === SymbolKind.Function || node.kind === SymbolKind.Method) && node.children) {
            node.children = node.children.filter(this._isNotVar);
        }

        return true;
    }

    private _isNotVar(s: PhpSymbol) {
        return s.kind !== SymbolKind.Variable;
    }


}

export class SymbolStore {

    private _tableIndex: SymbolTableIndex;
    private _symbolIndex: SymbolIndex;
    private _symbolCount: number;

    constructor(db: LevelUp) {
        this._tableIndex = new SymbolTableIndex(db);
        this._symbolIndex = new SymbolIndex;
        this._symbolCount = 0;
    }

    onParsedDocumentChange = (args: ParsedDocumentChangeEventArgs) => {
        this.remove(args.parsedDocument.uri);
        let table = SymbolTable.create(args.parsedDocument);
        this.add(table);
    };

    getSymbolTable(uri: string) {
        return this._tableIndex.find(uri);
    }

    get tables() {
        return this._tableIndex.tables();
    }

    get tableCount() {
        return this._tableIndex.count();
    }

    get symbolCount() {
        return this._symbolCount;
    }

    async add(symbolTable: SymbolTable) {
        //if table already exists replace it
        await this.remove(symbolTable.uri);
        await this._tableIndex.add(symbolTable);
        this._symbolIndex.index(symbolTable.root);
        this._symbolCount += symbolTable.symbolCount;
    }

    async remove(uri: string) {
        let symbolTable = await this._tableIndex.remove(uri);
        if (!symbolTable) {
            return;
        }
        this._symbolIndex.removeMany(uri);
        this._symbolCount -= symbolTable.symbolCount;
    }

    /**
     * Finds all indexed symbols that match text exactly.
     * Case sensitive for constants and variables and insensitive for 
     * classes, traits, interfaces, functions, methods
     * @param text 
     * @param filter 
     */
    find(text: string, filter?: Predicate<PhpSymbol>) {

        if (!text) {
            return [];
        }

        let result = this._symbolIndex.find(text);
        let symbols: PhpSymbol[] = [];

        for (let n = 0, l = result.length; n < l; ++n) {
            if (!filter || filter(result[n])) {
                symbols.push(result[n]);
            }
        }

        return symbols;
    }

    getNamedSymbol(uri: string) {
        return this._symbolIndex.getNamedSymbol(uri);
    }

    getGlobalVariables() {
        return this._symbolIndex.getGlobalVariables();
    }

    filter(filter: Predicate<PhpSymbol>) {
        return this._symbolIndex.filter(filter);
    }

    /**
     * matches indexed symbols where symbol keys begin with text.
     * Case insensitive
     */
    match(text: string, filter?: Predicate<PhpSymbol>) {

        if (!text) {
            return [];
        }

        let matches: PhpSymbol[] = this._symbolIndex.match(text).filter((symbol) => {
            return symbol;
        });

        if (!filter) {
            return matches;
        }

        return matches.filter((symbol) => {
            return filter(symbol);
        });
    }

    async findSymbolsByReference(ref: Reference, memberMergeStrategy?: MemberMergeStrategy): Promise<PhpSymbol[]> {
        if (!ref) {
            return [];
        }

        let symbols: PhpSymbol[];
        let fn: Predicate<PhpSymbol>;
        let lcName: string;
        let table: SymbolTable;

        switch (ref.kind) {
            case SymbolKind.Class:
            case SymbolKind.Interface:
            case SymbolKind.Trait:
                fn = (x) => {
                    return (x.kind & (SymbolKind.Class | SymbolKind.Interface | SymbolKind.Trait)) > 0;
                };
                symbols = this.find(ref.name, fn);
                break;

            case SymbolKind.Function:
            case SymbolKind.Constant:
                fn = (x) => {
                    return x.kind === ref.kind;
                };
                symbols = this.find(ref.name, fn);
                if (symbols.length < 1 && ref.altName) {
                    symbols = this.find(ref.altName, fn);
                }
                break;

            case SymbolKind.Method:
                fn = (x) => {
                    return x.kind === SymbolKind.Method && x.name === ref.name;
                };
                symbols = await this.findMembers(ref.scope, memberMergeStrategy || MemberMergeStrategy.None, fn);
                break;

            case SymbolKind.Property:
                {
                    let name = ref.name;
                    fn = (x) => {
                        return x.kind === SymbolKind.Property && name === x.name;
                    };
                    symbols = await this.findMembers(ref.scope, memberMergeStrategy || MemberMergeStrategy.None, fn);
                    break;
                }

            case SymbolKind.ClassConstant:
                fn = (x) => {
                    return x.kind === SymbolKind.ClassConstant && x.name === ref.name;
                };
                symbols = await this.findMembers(ref.scope, memberMergeStrategy || MemberMergeStrategy.None, fn);
                break;

            case SymbolKind.Variable:
            case SymbolKind.Parameter:
                //@todo global vars?
                table = await this.getSymbolTable(ref.location.uri);
                if (table) {
                    let scope = table.scope(ref.location.range.start);

                    fn = (x) => {
                        return (x.kind & (SymbolKind.Parameter | SymbolKind.Variable)) > 0 &&
                            x.name === ref.name;
                    }
                    let s = scope.children ? scope.children.find(fn) : null;
                    if (s) {
                        symbols = [s];
                    }
                }
                break;

            case SymbolKind.Constructor:
                fn = (x) => {
                    return x.kind === SymbolKind.Method && x.name.toLowerCase() === '__construct';
                };
                symbols = await this.findMembers(ref.name, memberMergeStrategy || MemberMergeStrategy.None, fn);
                break;

            default:
                break;

        }

        return symbols || [];
    }

    private async findMembers(
        scope: string | Promise<string>, memberMergeStrategy: MemberMergeStrategy, predicate?: Predicate<PhpSymbol>
    ) {

        let fqnArray = TypeString.atomicClassArray(await TypeString.resolve(scope));
        let type: TypeAggregate;
        let members: PhpSymbol[] = [];
        for (let n = 0; n < fqnArray.length; ++n) {
            type = TypeAggregate.create(this, fqnArray[n]);
            if (type) {
                Array.prototype.push.apply(members, type.members(memberMergeStrategy, predicate));
            }
        }
        return Array.from(new Set<PhpSymbol>(members));
    }

    private async findBaseMember(symbol: PhpSymbol) {

        if (
            !symbol || !symbol.scope ||
            !(symbol.kind & (SymbolKind.Property | SymbolKind.Method | SymbolKind.ClassConstant)) ||
            (symbol.modifiers & SymbolModifier.Private) > 0
        ) {
            return symbol;
        }

        let fn: Predicate<PhpSymbol>;

        if (symbol.kind === SymbolKind.Method) {
            fn = (s: PhpSymbol) => {
                return s.kind === symbol.kind && s.modifiers === symbol.modifiers && symbol.name === s.name;
            };
        } else {
            fn = (s: PhpSymbol) => {
                return s.kind === symbol.kind && s.modifiers === symbol.modifiers && symbol.name === s.name;
            };
        }

        return (await this.findMembers(symbol.scope, MemberMergeStrategy.Base, fn)).shift() || symbol;

    }

    /*
    findOverrides(baseSymbol: PhpSymbol): PhpSymbol[] {

        if (
            !baseSymbol ||
            !(baseSymbol.kind & (SymbolKind.Property | SymbolKind.Method | SymbolKind.ClassConstant)) ||
            (baseSymbol.modifiers & SymbolModifier.Private) > 0
        ) {
            return [];
        }

        let baseTypeName = baseSymbol.scope ? baseSymbol.scope : '';
        let baseType = this.find(baseTypeName, PhpSymbol.isClassLike).shift();
        if (!baseType || baseType.kind === SymbolKind.Trait) {
            return [];
        }
        let store = this;
        let filterFn = (s: PhpSymbol) => {

            if (s.kind !== baseSymbol.kind || s.modifiers !== baseSymbol.modifiers || s === baseSymbol) {
                return false;
            }

            let type = store.find(s.scope).shift();
            if (!type) {
                return false;
            }

            if (PhpSymbol.isAssociated(type, baseTypeName)) {
                return true;
            }

            let aggregate = new TypeAggregate(store, type);
            return aggregate.isAssociated(baseTypeName);

        };
        return this.find(baseSymbol.name, filterFn);

    }
    */

    async symbolLocation(symbol: PhpSymbol): Promise<Location> {
        let table = await this._tableIndex.findBySymbol(symbol);
        return table ? Location.create(table.uri, symbol.location.range) : undefined;
    }

    async referenceToTypeString(ref: Reference) {

        if (!ref) {
            return '';
        }

        switch (ref.kind) {
            case SymbolKind.Class:
            case SymbolKind.Interface:
            case SymbolKind.Trait:
            case SymbolKind.Constructor:
                return ref.name;

            case SymbolKind.Function:
            case SymbolKind.Method:
            case SymbolKind.Property:
                return (await this.findSymbolsByReference(ref, MemberMergeStrategy.Documented))
                    .reduce<string>((carry, val) => {
                        return TypeString.merge(carry, PhpSymbol.type(val));
                    }, '');

            case SymbolKind.Variable:
                return ref.type || '';

            default:
                return '';


        }
    }

    private _sortMatches(query: string, matches: PhpSymbol[]) {

        let map: { [index: string]: number } = {};
        let s: PhpSymbol;
        let name: string;
        let val: number;

        for (let n = 0, l = matches.length; n < l; ++n) {
            s = matches[n];
            name = s.name;
            if (map[name] === undefined) {
                val = (PhpSymbol.notFqn(s.name).indexOf(query) + 1) * 10;
                if (val > 0) {
                    val = 1000 - val;
                }
                map[name] = val;
            }
            ++map[name];
        }

        let unique = Array.from(new Set(matches));

        let sortFn = (a: PhpSymbol, b: PhpSymbol) => {
            return map[b.name] - map[a.name];
        }

        unique.sort(sortFn);
        return unique;

    }

    private _classOrInterfaceFilter(s: PhpSymbol) {
        return (s.kind & (SymbolKind.Class | SymbolKind.Interface)) > 0;
    }

    private _classInterfaceTraitFilter(s: PhpSymbol) {
        return (s.kind & (SymbolKind.Class | SymbolKind.Interface | SymbolKind.Trait)) > 0;
    }
}

class NameResolverVisitor implements TreeVisitor<PhpSymbol> {

    haltTraverse = false;
    private _kindMask = SymbolKind.Class | SymbolKind.Function | SymbolKind.Constant;

    constructor(public pos: Position, public nameResolver: NameResolver) { }

    preorder(node: PhpSymbol, spine: PhpSymbol[]) {

        if (node.location && node.location.range.start.line > this.pos.line) {
            this.haltTraverse = true;
            return false;
        }

        if ((node.modifiers & SymbolModifier.Use) > 0 && (node.kind & this._kindMask) > 0) {
            this.nameResolver.rules.push(node);
        } else if (node.kind === SymbolKind.Namespace) {
            this.nameResolver.namespace = node;
        } else if (node.kind === SymbolKind.Class) {
            this.nameResolver.pushClass(node);
        }

        return true;

    }

    postorder(node: PhpSymbol, spine: PhpSymbol[]) {

        if (this.haltTraverse || (node.location && node.location.range.end.line > this.pos.line)) {
            this.haltTraverse = true;
            return;
        }

        if (node.kind === SymbolKind.Class) {
            this.nameResolver.popClass();
        }

    }
}

class ScopeVisitor implements TreeVisitor<PhpSymbol> {

    haltTraverse = false;
    private _scopeStack: PhpSymbol[];
    private _kindMask = SymbolKind.Class | SymbolKind.Interface | SymbolKind.Trait | SymbolKind.Function | SymbolKind.Method | SymbolKind.File;
    private _absolute = false;

    constructor(public pos: Position, absolute: boolean) {
        this._scopeStack = [];
        this._absolute = absolute;
    }

    get scope() {
        return this._scopeStack[this._scopeStack.length - 1];
    }

    preorder(node: PhpSymbol, spine: PhpSymbol[]) {

        if (node.location && node.location.range.start.line > this.pos.line) {
            this.haltTraverse = true;
            return false;
        }

        if (!node.location || util.isInRange(this.pos, node.location.range) !== 0) {
            return false;
        }

        if (
            (node.kind & this._kindMask) > 0 &&
            !(node.modifiers & SymbolModifier.Use) &&
            (!this._absolute || node.kind !== SymbolKind.Function || !(node.modifiers & SymbolModifier.Anonymous))
        ) {
            this._scopeStack.push(node);
        }

        return true;
    }

}

class ContainsVisitor implements TreeVisitor<PhpSymbol> {

    haltTraverse = false;
    found = false;
    private _symbol: PhpSymbol;

    constructor(symbol: PhpSymbol) {
        this._symbol = symbol;
        if (!symbol.location) {
            throw new Error('Invalid Argument');
        }
    }

    preorder(node: PhpSymbol, spine: PhpSymbol[]) {

        if (node === this._symbol) {
            this.found = true;
            this.haltTraverse = true;
            return false;
        }

        if (node.location && util.isInRange(this._symbol.location.range.start, node.location.range) !== 0) {
            return false;
        }

        return true;

    }

}
