/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import { ParsedDocument } from './parsedDocument';
import { SymbolTable } from './symbolStore';
import { PhpSymbol, SymbolKind, SymbolModifier, SymbolIdentifier } from './symbol';
import { Position, TextEdit, Range } from 'vscode-languageserver-types';
import { TreeVisitor } from './types';
import * as util from './utils';
import { SyntaxNode } from 'tree-sitter';

export class UseDeclarationHelper {

    private _useDeclarations: PhpSymbol[];
    private _afterNode: SyntaxNode;
    private _afterNodeRange: Range;
    private _cursor: Position;

    constructor(public doc: ParsedDocument, public table: SymbolTable, cursor: Position) {
        this._useDeclarations = table.filter(this._isUseDeclarationSymbol);
        this._cursor = cursor;
    }

    insertDeclarationTextEdit(symbol: SymbolIdentifier, alias?: string) {
        let afterNode = this._insertAfterNode();

        let text = '\n';
        if (afterNode.type === 'namespace_definition') {
            text += '\n';
        }

        text += util.whitespace(this._insertAfterNodeRange().start.character);
        text += 'use ';

        switch (symbol.kind) {
            case SymbolKind.Constant:
                text += 'const ';
                break;
            case SymbolKind.Function:
                text += 'function ';
                break;
            default:
                break;
        }

        text += symbol.name;

        if (alias) {
            text += ' as ' + alias;
        }

        text += ';';

        if (afterNode.type !== 'namespace_use_declaration') {
            text += '\n';
        }

        return TextEdit.insert(this._insertPosition(), text);

    }

    replaceDeclarationTextEdit(symbol: SymbolIdentifier, alias: string) {
        let useSymbol = this.findUseSymbolByFqn(symbol.name);

        if (!useSymbol || !useSymbol.location) {
            return null;
        }

        let node = this.findNamespaceUseClauseByRange(useSymbol.location.range);

        if (!node) {
            return null;
        }

        let aliasingClause = ParsedDocument.findChild(node, this._isNamespaceAliasingClause);

        if (aliasingClause) {
            return TextEdit.replace(this.doc.nodeRange(aliasingClause), `as ${alias}`);
        } else {
            return TextEdit.insert(this.doc.nodeRange(node).end, ` as ${alias}`);
        }
    }

    deleteDeclarationTextEdit(fqn: string) {

    }

    findUseSymbolByFqn(fqn: string) {
        let lcFqn = fqn.toLowerCase();
        let fn = (x: PhpSymbol) => {
            return x.associated && x.associated.length > 0 && x.associated[0].name.toLowerCase() === lcFqn;
        }
        return this._useDeclarations.find(fn);
    }

    findUseSymbolByName(name: string) {

        let lcName = name.toLowerCase();
        let fn = (x: PhpSymbol) => {
            return x.name.toLowerCase() === lcName;
        }

        return this._useDeclarations.find(fn);

    }

    findNamespaceUseClauseByRange(range: Range) {

        let fn = (x: SyntaxNode) => {
            return (x.type === 'namespace_use_clause' || x.type === 'namespace_use_group_clause_2') &&
                util.rangeEquality(range, this.doc.nodeRange(x));
        };

        return this.doc.find(fn);

    }

    private _isUseDeclarationSymbol(s: PhpSymbol) {
        const mask = SymbolKind.Class | SymbolKind.Function | SymbolKind.Constant;
        return typeof s.modifiers !== 'undefined' &&
            (s.modifiers & SymbolModifier.Use) > 0 && (s.kind & mask) > 0;
    }

    private _insertAfterNode() {

        if (this._afterNode) {
            return this._afterNode;
        }

        let visitor = new InsertAfterNodeVisitor(this.doc, this.doc.offsetAtPosition(this._cursor));
        this.doc.traverse(visitor);
        return this._afterNode = visitor.lastNamespaceUseDeclaration || visitor.namespaceDefinition || visitor.openingInlineText;
    }

    private _insertAfterNodeRange() {

        if (this._afterNodeRange) {
            return this._afterNodeRange;
        }

        return this._afterNodeRange = this.doc.nodeRange(this._insertAfterNode());

    }

    private _insertPosition() {
        return this._insertAfterNodeRange().end;
    }

    private _isNamespaceAliasingClause(node: SyntaxNode) {
        return node.type === 'namespace_aliasing_clause';
    }

}

class InsertAfterNodeVisitor implements TreeVisitor<SyntaxNode> {

    private _openingInlineText: SyntaxNode;
    private _lastNamespaceUseDeclaration: SyntaxNode;
    private _namespaceDefinition: SyntaxNode;

    haltTraverse = false;
    haltAtOffset = -1;

    constructor(
        public document: ParsedDocument,
        offset: number) {
        this.haltAtOffset = offset;
    }

    get openingInlineText() {
        return this._openingInlineText;
    }

    get lastNamespaceUseDeclaration() {
        return this._lastNamespaceUseDeclaration;
    }

    get namespaceDefinition() {
        return this._namespaceDefinition;
    }

    preorder(node: SyntaxNode, spine: SyntaxNode[]) {

        switch (node.type) {
            case 'text':
                if (!this._openingInlineText) {
                    this._openingInlineText = node;
                }
                break;

            case 'namespace_definition':
                this._namespaceDefinition = node;
                break;

            case 'namespace_use_declaration':
                this._lastNamespaceUseDeclaration = node;
                break;

            default:
                break;

        }

        return true;

    }

}