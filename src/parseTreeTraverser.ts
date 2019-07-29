/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import { ReferenceTable, Reference } from './reference';
import { SymbolTable } from './symbolStore';
import { TreeTraverser } from './types';
import { ParsedDocument } from './parsedDocument';
import { Position, Range } from 'vscode-languageserver-types';
import { SyntaxNode } from 'tree-sitter';
import { Parser } from './parser';

export class ParseTreeTraverser extends TreeTraverser<SyntaxNode> {

    private _doc: ParsedDocument;
    private _symbolTable: SymbolTable;
    private _refTable: ReferenceTable;

    constructor(document: ParsedDocument, symbolTable: SymbolTable, refTable: ReferenceTable) {
        super([document.tree.rootNode]);
        this._doc = document;
        this._symbolTable = symbolTable;
        this._refTable = refTable;
    }

    get document() {
        return this._doc;
    }

    get symbolTable() {
        return this._symbolTable;
    }

    get refTable() {
        return this._refTable;
    }

    get text() {
        if (this.node == null) {
            return '';
        }

        return this.node.text;
    }

    get range() {
        if (this.node == null) {
            return null;
        }

        return this._doc.nodeRange(this.node);
    }

    get reference() {
        const range = this.range;

        if (range == null) {
            return null;
        }
        return this._refTable.referenceAtPosition(range.start);
    }

    get scope() {
        let range = this.range;
        if (!range) {
            return null;
        }
        return this._symbolTable.scope(range.start);
    }

    get nameResolver() {
        const pos = this.node != null ? Parser.toPosition(this.node.startPosition) : Position.create(
            0, 0
        );
        return this._symbolTable.nameResolver(pos);
    }

    /**
     * Traverses to the token to the left of position
     * @param pos 
     */
    position(pos: Position) {
        let offset = this._doc.offsetAtPosition(pos) - 1;
        let fn = (node: SyntaxNode) => {
            return node.childCount === 0 && offset < node.endIndex && offset >= node.startIndex;
        };

        return this.find(fn);
    }

    clone() {
        let spine = this.spine;
        let traverser = new ParseTreeTraverser(this._doc, this._symbolTable, this._refTable);
        traverser._spine = spine;
        return traverser;
    }

    prevToken() {

        const spine = this._spine.slice(0);
        let current: SyntaxNode | undefined;
        let parent: SyntaxNode;
        let prevSiblingIndex: number;

        while (spine.length > 1) {

            current = spine.pop() as SyntaxNode;
            parent = spine[spine.length - 1];
            prevSiblingIndex = parent.children.indexOf(current) - 1;

            if (prevSiblingIndex > -1) {
                spine.push(parent.children[prevSiblingIndex]);
                if (this._lastToken(spine)) {
                    //token found
                    this._spine = spine;
                    return this.node;
                }
            }

            //go up

        }

        return null;

    }

    private _lastToken(spine: SyntaxNode[]) {

        let node = spine[spine.length - 1];

        if (!node) {
            return spine;
        }

        const children = node.children;

        for (let n = children.length - 1; n >= 0; --n) {
            spine.push(children[n]);
            if (this._lastToken(spine)) {
                return spine;
            } else {
                spine.pop();
            }
        }

        return null;

    }

}
