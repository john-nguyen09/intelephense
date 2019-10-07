/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import { Phrase, Token, TokenKind, PhraseKind, Parser, Node,
    isToken as baseIsToken, isPhrase as baseIsPhrase
} from 'php7parser';
import { TextDocument } from './textDocument';
import * as lsp from 'vscode-languageserver-types';
import {
    TreeVisitor, TreeTraverser, Event, Debounce, Unsubscribe,
    Predicate, Traversable
} from './types';
import * as AsyncLock from 'async-lock';
import { Log } from './logger';

const textDocumentChangeDebounceWait = 250;

export interface NodeTransform {
    phraseKind?: PhraseKind;
    tokenKind?: TokenKind;
    push(transform: NodeTransform): void;
}

export interface ParsedDocumentChangeEventArgs {
    parsedDocument: ParsedDocument;
}

export class ParsedDocument implements Traversable<Phrase | Token>{

    private static _wordRegex = /[$a-zA-Z_\x80-\xff][\\a-zA-Z0-9_\x80-\xff]*$/;
    private _textDocument: TextDocument;
    private _parseTree: Phrase;
    private _changeEvent: Event<ParsedDocumentChangeEventArgs>;
    private _debounce: Debounce<null>;
    private _reparse = (x) => {
        this._parseTree = Parser.parse(this._textDocument.text);
        this._changeEvent.trigger({ parsedDocument: this });
    };

    constructor(uri: string, text: string, public version = 0) {
        this._parseTree = Parser.parse(text);
        this._textDocument = new TextDocument(uri, text);
        this._debounce = new Debounce<null>(this._reparse, textDocumentChangeDebounceWait);
        this._changeEvent = new Event<ParsedDocumentChangeEventArgs>();
    }

    get tree() {
        return this._parseTree;
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

    find(predicate: Predicate<Phrase | Token>) {
        let traverser = new TreeTraverser([this._parseTree]);
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

    traverse(visitor: TreeVisitor<Phrase | Token>) {
        let traverser = new TreeTraverser<Phrase | Token>([this._parseTree]);
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
        }

        this._debounce.handle(null);

    }

    tokenRange(t: Token) {
        if (!t) {
            return null;
        }

        let r = <lsp.Range>{
            start: this._textDocument.positionAtOffset(t.offset),
            end: this._textDocument.positionAtOffset(t.offset + t.length)
        }

        return r;
    }

    nodeLocation(node: Node) {

        if (!node) {
            return undefined;
        }

        let range = this.nodeRange(node);

        if (!range) {
            return undefined;
        }

        return lsp.Location.create(this.uri, range);

    }

    nodeRange(node: Node) {

        if (!node) {
            return null;
        }

        if (ParsedDocument.isToken(node)) {
            return this.tokenRange(node);
        }

        let tFirst = ParsedDocument.firstToken(node);
        let tLast = ParsedDocument.lastToken(node);

        if (!tFirst || !tLast) {
            return lsp.Range.create(0, 0, 0, 0);
        }

        let range = <lsp.Range>{
            start: this._textDocument.positionAtOffset(tFirst.offset),
            end: this._textDocument.positionAtOffset(tLast.offset + tLast.length)
        }

        return range;

    }

    tokenText(t: Token) {
        return t && t.kind !== undefined ? this._textDocument.textAtOffset(t.offset, t.length) : '';
    }

    nodeText(node: Node) {

        if (!node) {
            return '';
        }

        if (ParsedDocument.isToken(node)) {
            return this._textDocument.textAtOffset((<Token>node).offset, (<Token>node).length);
        }

        let tFirst = ParsedDocument.firstToken(node);
        let tLast = ParsedDocument.lastToken(node);

        if (!tFirst || !tLast) {
            return '';
        }

        return this._textDocument.text.slice(tFirst.offset, tLast.offset + tLast.length);

    }

    createAnonymousName(node: Phrase) {
        let tFirst = ParsedDocument.firstToken(node);
        let offset = tFirst ? tFirst.offset : 0;
        return `#anon#${this.uri}#${offset}`;
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

}

export namespace ParsedDocument {

    export function firstToken(node: Node) {

        if (isToken(node)) {
            return node as Token;
        }

        let t: Token;
        for (let n = 0, l = (<Phrase>node).children.length; n < l; ++n) {
            t = this.firstToken((<Phrase>node).children[n]);
            if (t !== null) {
                return t;
            }
        }

        return null;
    }

    export function lastToken(node: Node) {
        if (isToken(node)) {
            return node;
        }

        let t: Token;
        for (let n = (<Phrase>node).children.length - 1; n >= 0; --n) {
            t = this.lastToken((<Phrase>node).children[n]);
            if (t !== null) {
                return t;
            }
        }

        return null;
    }

    export function isToken(node: Node, types?: TokenKind[]): node is Token {
        return baseIsToken(node) &&
            (!types || types.indexOf(node.kind) > -1);
    }

    export function isPhrase(node: Node, types?: PhraseKind[]): node is Phrase {
        return baseIsPhrase(node) &&
            (!types || types.indexOf(node.kind) > -1);
    }

    export function isOffsetInToken(offset: number, t: Token) {
        return offset > -1 && isToken(t) &&
            t.offset <= offset &&
            t.offset + t.length - 1 >= offset;
    }

    export function isOffsetInNode(offset, node: Phrase | Token) {

        if (!node || offset < 0) {
            return false;
        }

        if (isToken(node)) {
            return ParsedDocument.isOffsetInToken(offset, <Token>node);
        }

        let tFirst = ParsedDocument.firstToken(node);
        let tLast = ParsedDocument.lastToken(node);

        if (!tFirst || !tLast) {
            return false;
        }

        return tFirst.offset <= offset && tLast.offset + tLast.length - 1 >= offset;

    }

    export function findChild(parent: Phrase, fn: Predicate<Node>) {

        if (!parent || !parent.children) {
            return undefined;
        }

        let child: Node;
        for (let n = 0, l = parent.children.length; n < l; ++n) {
            child = parent.children[n];
            if (fn(child)) {
                return child;
            }
        }
        return undefined;
    }

    export function filterChildren(parent: Phrase, fn: Predicate<Node>) {

        let filtered: Node[] = [];
        if (!parent || !parent.children) {
            return filtered;
        }

        let child: Node;
        for (let n = 0, l = parent.children.length; n < l; ++n) {
            child = parent.children[n];
            if (fn(child)) {
                filtered.push(child);
            }
        }
        return filtered;
    }

    export function isNamePhrase(node: Phrase | Token) {
        if (!node) {
            return false;
        }

        switch (node.kind) {
            case PhraseKind.QualifiedName:
            case PhraseKind.RelativeQualifiedName:
            case PhraseKind.FullyQualifiedName:
                return true;
            default:
                return false;
        }
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
        try {
            await this._lock.acquire(uri, action);
        } catch (err) {
            Log.error(err);
        }
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

class ToStringVisitor implements TreeVisitor<Phrase | Token> {

    private _text: string;
    private _doc: ParsedDocument;
    private _ignore: TokenKind[];

    constructor(doc: ParsedDocument, ignore?: TokenKind[]) {
        this._text = '';
        this._doc = doc;
    }

    get text() {
        return this._text;
    }

    postorder(node: Phrase | Token, spine: (Phrase | Token)[]) {

        if (ParsedDocument.isToken(node) && (!this._ignore || this._ignore.indexOf(node.kind) < 0)) {
            this._text += this._doc.tokenText(<Token>node);
        }

    }

}

export interface LanguageRange {
    range: lsp.Range;
    languageId?: string;
}

const phpLanguageId = 'php';

class DocumentLanguageRangesVisitor implements TreeVisitor<Phrase | Token> {

    private _ranges: LanguageRange[];
    private _phpOpenPosition: lsp.Position;
    private _lastToken: Token;

    constructor(public doc: ParsedDocument) {
        this._ranges = [];
    }

    get ranges() {
        //handle no close tag
        if (this._phpOpenPosition && this._lastToken) {
            this._ranges.push({
                range: lsp.Range.create(this._phpOpenPosition, this.doc.tokenRange(this._lastToken).end),
                languageId: phpLanguageId
            });
            this._phpOpenPosition = undefined;
        }
        return this._ranges;
    }

    preorder(node: Phrase | Token, spine: (Phrase | Token)[]) {

        switch (node.kind) {
            case TokenKind.Text:
                this._ranges.push({ range: this.doc.tokenRange(<Token>node) });
                break;
            case TokenKind.OpenTag:
            case TokenKind.OpenTagEcho:
                this._phpOpenPosition = this.doc.tokenRange(<Token>node).start;
                break;
            case TokenKind.CloseTag:
                {
                    let closeTagRange = this.doc.tokenRange(<Token>node);
                    this._ranges.push({
                        range: lsp.Range.create(this._phpOpenPosition || closeTagRange.start, closeTagRange.end),
                        languageId: phpLanguageId
                    });
                    this._phpOpenPosition = undefined;
                }

                break;
            default:
                break;
        }

        if (ParsedDocument.isToken(node)) {
            this._lastToken = <Token>node;
        }

        return true;

    }

}
