import { PhpSymbol } from './symbol';
import { Reference, ReferenceTable } from './reference';
import { SymbolTable } from './symbolStore';
import { NameResolver } from './nameResolver';
import { TreeTraverser } from './types';
import { ParsedDocument } from './parsedDocument';
import { Position, Range } from 'vscode-languageserver-types';
import { Phrase, Token } from 'php7parser';
export declare class ParseTreeTraverser extends TreeTraverser<Phrase | Token> {
    private _doc;
    private _symbolTable;
    private _refTable;
    constructor(document: ParsedDocument, symbolTable: SymbolTable, refTable: ReferenceTable);
    readonly document: ParsedDocument;
    readonly symbolTable: SymbolTable;
    readonly refTable: ReferenceTable;
    readonly text: string;
    readonly range: Range;
    readonly reference: Reference;
    readonly scope: PhpSymbol;
    readonly nameResolver: NameResolver;
    /**
     * Traverses to the token to the left of position
     * @param pos
     */
    position(pos: Position): Token;
    clone(): ParseTreeTraverser;
    /**
     * True if current node is the name part of a declaration
     */
    readonly isDeclarationName: boolean;
    private _isDeclarationPhrase(node);
}
