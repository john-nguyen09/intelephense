import { PhpSymbol } from './symbol';
import { Reference } from './reference';
import { TreeTraverser, Predicate, TreeVisitor, Traversable } from './types';
import { Position, Location } from 'vscode-languageserver-types';
import { ParsedDocument, ParsedDocumentChangeEventArgs } from './parsedDocument';
import { NameResolver } from './nameResolver';
import { MemberMergeStrategy } from './typeAggregate';
export declare class SymbolTable implements Traversable<PhpSymbol> {
    private _uri;
    private _root;
    private _hash;
    constructor(uri: string, root: PhpSymbol, hash?: number);
    readonly uri: string;
    readonly root: PhpSymbol;
    readonly hash: number;
    readonly symbols: PhpSymbol[];
    readonly symbolCount: number;
    pruneScopedVars(): void;
    parent(s: PhpSymbol): PhpSymbol;
    traverse(visitor: TreeVisitor<PhpSymbol>): TreeVisitor<PhpSymbol>;
    createTraverser(): TreeTraverser<PhpSymbol>;
    filter(predicate: Predicate<PhpSymbol>): PhpSymbol[];
    find(predicate: Predicate<PhpSymbol>): PhpSymbol;
    nameResolver(pos: Position): NameResolver;
    scope(pos: Position): PhpSymbol;
    absoluteScope(pos: Position): PhpSymbol;
    scopeSymbols(): PhpSymbol[];
    symbolAtPosition(position: Position): PhpSymbol;
    contains(s: PhpSymbol): boolean;
    private _isScopeSymbol(s);
    static fromJSON(data: any): SymbolTable;
    static create(parsedDocument: ParsedDocument, externalOnly?: boolean): SymbolTable;
    static readBuiltInSymbols(): SymbolTable;
}
export declare class SymbolStore {
    private _tableIndex;
    private _symbolIndex;
    private _symbolCount;
    constructor();
    onParsedDocumentChange: (args: ParsedDocumentChangeEventArgs) => void;
    getSymbolTable(uri: string): SymbolTable;
    readonly tables: IterableIterator<SymbolTable>;
    readonly tableCount: number;
    readonly symbolCount: number;
    add(symbolTable: SymbolTable): void;
    remove(uri: string): void;
    toJSON(): {
        _tableIndex: SymbolTableIndex;
        _symbolCount: number;
    };
    fromJSON(data: any): void;
    /**
     * Finds all indexed symbols that match text exactly.
     * Case sensitive for constants and variables and insensitive for
     * classes, traits, interfaces, functions, methods
     * @param text
     * @param filter
     */
    find(text: string, filter?: Predicate<PhpSymbol>): PhpSymbol[];
    filter(filter: Predicate<PhpSymbol>): PhpSymbol[];
    /**
     * matches indexed symbols where symbol keys begin with text.
     * Case insensitive
     */
    match(text: string, filter?: Predicate<PhpSymbol>): PhpSymbol[];
    findSymbolsByReference(ref: Reference, memberMergeStrategy?: MemberMergeStrategy): PhpSymbol[];
    findMembers(scope: string, memberMergeStrategy: MemberMergeStrategy, predicate?: Predicate<PhpSymbol>): PhpSymbol[];
    findBaseMember(symbol: PhpSymbol): PhpSymbol;
    symbolLocation(symbol: PhpSymbol): Location;
    referenceToTypeString(ref: Reference): string;
    private _sortMatches(query, matches);
    private _classOrInterfaceFilter(s);
    private _classInterfaceTraitFilter(s);
    private _indexSymbols(root);
    /**
     * No vars, params or symbols with use modifier
     * @param s
     */
    private _indexFilter(s);
    private _symbolKeys(s);
}
export declare class SymbolTableIndex {
    private _count;
    private _tables;
    constructor();
    count(): number;
    tables(): IterableIterator<SymbolTable>;
    add(table: SymbolTable): void;
    remove(uri: string): SymbolTable;
    find(uri: string): SymbolTable;
    findBySymbol(s: PhpSymbol): SymbolTable;
    toJSON(): {
        _tables: Map<string, SymbolTable>;
        _count: number;
    };
    fromJSON(data: any): void;
}
export interface SymbolTableIndexNode {
    hash: number;
    tables: SymbolTable[];
}
