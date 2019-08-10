/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import { TextDocument } from './textDocument';
import * as lsp from 'vscode-languageserver-types';
import {
    TreeVisitor, TreeTraverser, Event, Debounce, Unsubscribe,
    Predicate, Traversable
} from './types';
import * as AsyncLock from 'async-lock';
import { SyntaxNode, Tree, Edit } from 'tree-sitter';
import { Parser } from './parser';

const textDocumentChangeDebounceWait = 250;

export interface NodeTransform {
    kind: string;
    push?(transform: NodeTransform): void;
}

export interface ParsedDocumentChangeEventArgs {
    parsedDocument: ParsedDocument;
}

export class ParsedDocument implements Traversable<SyntaxNode>{

    private static _wordRegex = /[$a-zA-Z_\x80-\xff][\\a-zA-Z0-9_\x80-\xff]*$/;
    private _textDocument: TextDocument;
    private _tree: Tree;
    private _changeEvent: Event<ParsedDocumentChangeEventArgs>;
    private _debounce: Debounce<null>;
    private _reparse = (x) => {
        this._tree = Parser.parse(this._textDocument.text, this._tree);
        this._changeEvent.trigger({ parsedDocument: this });
    };

    constructor(uri: string, text: string, public version = 0) {
        this._tree = Parser.parse(text);
        this._textDocument = new TextDocument(uri, text);
        this._debounce = new Debounce<null>(this._reparse, textDocumentChangeDebounceWait);
        this._changeEvent = new Event<ParsedDocumentChangeEventArgs>();
    }

    get tree() {
        return this._tree;
    }

    get uri() {
        return this._textDocument.uri;
    }

    get text() {
        return this._textDocument.text;
    }

    get changeEvent() {
        return this._changeEvent;
    }

    find(predicate: Predicate<SyntaxNode>) {
        let traverser = new TreeTraverser([this._tree.rootNode]);
        return traverser.find(predicate);
    }

    textBeforeOffset(offset: number, length: number) {
        return this._textDocument.textBeforeOffset(offset, length);
    }

    lineSubstring(offset: number) {
        return this._textDocument.lineSubstring(offset);
    }

    wordAtOffset(offset: number) {
        let lineText = this._textDocument.lineSubstring(offset);
        let match = lineText.match(ParsedDocument._wordRegex);
        return match ? match[0] : '';
    }

    flush() {
        this._debounce.flush();
    }

    traverse(visitor: TreeVisitor<SyntaxNode>) {
        let traverser = new TreeTraverser<SyntaxNode>([this._tree.rootNode]);
        traverser.traverse(visitor);
        return visitor;
    }

    applyChanges(contentChanges: lsp.TextDocumentContentChangeEvent[]) {

        let change: lsp.TextDocumentContentChangeEvent;

        for (let n = 0, l = contentChanges.length; n < l; ++n) {
            change = contentChanges[n];
            if(!change.range) {
                this._textDocument.text = change.text;
            } else {
                this._textDocument.applyEdit(change.range.start, change.range.end, change.text);
            }

            const delta = this._toTreeSitterDelta(change);
            if (delta) {
                this._tree.edit(delta);
            }
        }

        this._debounce.handle(null);

    }

    nodeLocation(node: SyntaxNode) {

        let range = this.nodeRange(node);

        return lsp.Location.create(this.uri, range);

    }

    nodeRange(node: SyntaxNode) {

        const nodeStart = node.startPosition;
        const nodeEnd = node.endPosition;

        const range = <lsp.Range> {
            start: lsp.Position.create(nodeStart.row, nodeStart.column),
            end: lsp.Position.create(nodeEnd.row, nodeEnd.column),
        }

        return range;

    }

    createAnonymousName(node: SyntaxNode) {
        return `#anon#${this.uri}#${node.startIndex}`;
    }

    positionAtOffset(offset: number) {
        return this._textDocument.positionAtOffset(offset);
    }

    offsetAtPosition(position: lsp.Position) {
        return this._textDocument.offsetAtPosition(position);
    }

    documentLanguageRanges() {
        let visitor = new DocumentLanguageRangesVisitor(this);
        this.traverse(visitor);
        return visitor.ranges;
    }

    private _toTreeSitterDelta(e: lsp.TextDocumentContentChangeEvent): Edit | null {
        if (!e.range || !e.rangeLength) {
            return null;
        }

        const startIndex = this.offsetAtPosition(e.range.start);
        const oldEndIndex = startIndex + e.rangeLength;
        const newEndIndex = startIndex + e.text.length;
        const startPos = this.positionAtOffset(startIndex);
        const oldEndPos = this.positionAtOffset(oldEndIndex);
        const newEndPos = this.positionAtOffset(newEndIndex);
        const startPosition = Parser.toPoint(startPos);
        const oldEndPosition = Parser.toPoint(oldEndPos);
        const newEndPosition = Parser.toPoint(newEndPos);

        return {
            startIndex,
            oldEndIndex,
            newEndIndex,
            startPosition,
            oldEndPosition,
            newEndPosition
        };
    }

}

export namespace ParsedDocument {

    export function isOffsetInNode(offset: number, node: SyntaxNode) {
        return offset > - 1 &&
            node.startIndex <= offset &&
            node.endIndex >= offset;
    }

    export function findChild(parent: SyntaxNode, predicate: Predicate<SyntaxNode>) {

        if (!parent || !parent.children) {
            return undefined;
        }

        for (const child of parent.children) {
            if (predicate(child)) {
                return child;
            }
        }
        return undefined;
    }

    export function filterChildren(parent: SyntaxNode | undefined, predicate: Predicate<SyntaxNode>) {

        const filtered: SyntaxNode[] = [];
        if (!parent || !parent.children) {
            return filtered;
        }

        for (const child of parent.children) {
            if (predicate(child)) {
                filtered.push(child);
            }
        }
        return filtered;
    }

    export function isNamePhrase(node: SyntaxNode) {
        return node.isNamed;
    }

}

export class ParsedDocumentStore {

    private _parsedDocumentChangeEvent: Event<ParsedDocumentChangeEventArgs>;
    private _parsedDocumentmap: { [index: string]: ParsedDocument };
    private _unsubscribeMap: { [index: string]: Unsubscribe };
    private _bubbleEvent = (args: ParsedDocumentChangeEventArgs) => {
        this._parsedDocumentChangeEvent.trigger(args);
    }
    private _lock: AsyncLock;

    constructor() {
        this._parsedDocumentmap = {};
        this._parsedDocumentChangeEvent = new Event<ParsedDocumentChangeEventArgs>();
        this._unsubscribeMap = {};
        this._lock = new AsyncLock();
    }

    get parsedDocumentChangeEvent() {
        return this._parsedDocumentChangeEvent;
    }

    get count() {
        return Object.keys(this._parsedDocumentmap).length;
    }

    get documents() {
        return Object.keys(this._parsedDocumentmap).map((v) => {
            return this._parsedDocumentmap[v];
        });
    }

    async acquireLock(uri: string, action: () => void | PromiseLike<void>) {
        return this._lock.acquire(uri, action);
    }

    has(uri: string) {
        return this._parsedDocumentmap[uri] !== undefined;
    }

    add(parsedDocument: ParsedDocument) {
        if (this.has(parsedDocument.uri)) {
            throw new Error('Duplicate key');
        }

        this._parsedDocumentmap[parsedDocument.uri] = parsedDocument;
        this._unsubscribeMap[parsedDocument.uri] = parsedDocument.changeEvent.subscribe(this._bubbleEvent);
    }

    remove(uri: string) {

        if (!this.has(uri)) {
            return;
        }

        let unsubscribe = this._unsubscribeMap[uri];
        unsubscribe();
        delete this._parsedDocumentmap[uri];

    }

    find(uri: string) {
        return this._parsedDocumentmap[uri];
    }

}

export interface LanguageRange {
    range: lsp.Range;
    languageId?: string;
}

class DocumentLanguageRangesVisitor implements TreeVisitor<SyntaxNode> {

    private _ranges: LanguageRange[];

    constructor(public doc: ParsedDocument) {
        this._ranges = [];
    }

    get ranges() {
        return this._ranges;
    }

    preorder(node: SyntaxNode, spine: SyntaxNode[]) {

        return true;

    }

}
