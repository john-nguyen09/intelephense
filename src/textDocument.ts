/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import { BinarySearch } from './types';
import { Phrase, Token } from 'php7parser';
import { Position, Range } from 'vscode-languageserver-types';
import { substrCount } from './util';

export class TextDocument {

    private _uri: string;
    private _text: string;

    constructor(uri: string, text: string) {
        this._uri = uri;
        this.text = text;
    }

    get uri() {
        return this._uri;
    }

    get text() {
        return this._text;
    }

    set text(text: string) {
        this._text = text;
    }

    textBeforeOffset(offset:number, length:number){
        let start = Math.min(offset - (length - 1), 0);
        return this._text.slice(start, offset + 1);
    }

    lineSubstring(offset: number) {
        const pos = this.positionAtOffset(offset);
        const lineOffset = offset - pos.character;
        return this._text.slice(lineOffset, offset);
    }

    textAtOffset(offset: number, length: number) {
        return this._text.substr(offset, length);
    }

    positionAtOffset(offset: number) {
        let startAt = Math.min(offset, this.text.length);
        let lastNewLine = this.text.lastIndexOf("\n", startAt - 1);
        let character = offset - (lastNewLine + 1);
        let line = offset > 0 ? substrCount(this.text, "\n", 0, offset) : 0;

        return { line, character };
    }

    offsetAtPosition(pos: Position) {
        let lines = this.text.split('\n');
        let slice = lines.slice(0, pos.line);

        let lineCount = 0;

        if (slice.length > 0) {
            lineCount = slice.map((line) => {
                return line.length;
            }).reduce((total, lineCount) => {
                return total + lineCount;
            });
        }

        return lineCount + slice.length + pos.character;
    }

    applyEdit(start: Position, end: Position, text: string) {

        let startOffset = this.offsetAtPosition(start);
        let endOffset = this.offsetAtPosition(end);
        this._text = this._text.slice(0, startOffset) + text + this._text.slice(endOffset);
    }

}

