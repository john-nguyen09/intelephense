/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import * as lsp from 'vscode-languageserver-types';
import { TreeVisitor } from '../types'
import { Phrase, Token, PhraseKind, TokenKind, isPhrase, isToken } from 'php7parser';
import { ParsedDocument, ParsedDocumentStore } from '../parsedDocument';

interface FormatRule {
    (previous: Token, doc: ParsedDocument, indentText: string, indentUnit: string): lsp.TextEdit;
}

export class FormatProvider {

    private static blkLinePattern = /^(\r\n|\r|\n){2}$/;

    constructor(public docStore: ParsedDocumentStore) { }

    provideDocumentFormattingEdits(doc: lsp.TextDocumentIdentifier, formatOptions: lsp.FormattingOptions): lsp.TextEdit[] {

        let parsedDoc = this.docStore.find(doc.uri);

        if (!parsedDoc) {
            return [];
        }

        let visitor = new FormatVisitor(parsedDoc, formatOptions);
        parsedDoc.traverse(visitor);
        let edits = visitor.edits;
        let text = parsedDoc.text;

        if (
            visitor.firstToken &&
            visitor.firstToken.kind === TokenKind.OpenTag &&
            visitor.OpenTagCount === 1
        ) {
            //must omit close tag if php only and end in blank line
            let closeTagIndex = visitor.last3Tokens.findIndex(this._isCloseTag);
            let endEdit: lsp.TextEdit;
            let lastToken = visitor.last3Tokens.length ? visitor.last3Tokens[visitor.last3Tokens.length - 1] : undefined;
            let lastTokenText = parsedDoc.tokenText(lastToken);

            if (closeTagIndex < 0) {
                //last token should be \n\n
                if (lastToken && lastToken.kind === TokenKind.Whitespace && lastTokenText.search(FormatProvider.blkLinePattern) < 0) {
                    endEdit = lsp.TextEdit.replace(parsedDoc.tokenRange(lastToken), '\n\n');
                } else if (lastToken && lastToken.kind !== TokenKind.Whitespace) {
                    endEdit = lsp.TextEdit.insert(parsedDoc.tokenRange(lastToken).end, '\n\n');
                }
            } else if (closeTagIndex > 0 && (lastToken.kind === TokenKind.CloseTag || (lastToken.kind === TokenKind.Text && !lastTokenText.trim()))) {
                let tokenBeforeClose = visitor.last3Tokens[closeTagIndex - 1];
                let replaceStart: lsp.Position;
                if (tokenBeforeClose.kind === TokenKind.Whitespace) {
                    replaceStart = parsedDoc.tokenRange(tokenBeforeClose).start;
                } else {
                    replaceStart = parsedDoc.tokenRange(visitor.last3Tokens[closeTagIndex]).start;
                }
                endEdit = lsp.TextEdit.replace({ start: replaceStart, end: parsedDoc.tokenRange(lastToken).end }, '\n\n');
                if (edits.length) {
                    let lastEdit = edits[edits.length - 1];
                    if (lastEdit.range.end.line > endEdit.range.start.line ||
                        (lastEdit.range.end.line === endEdit.range.start.line && lastEdit.range.end.character > endEdit.range.start.character)) {
                        edits.shift();
                    }
                }
                
            }

            if(endEdit) {
                edits.unshift(endEdit);
            }

        }

        return edits;
    }

    provideDocumentRangeFormattingEdits(doc: lsp.TextDocumentIdentifier, range: lsp.Range, formatOptions: lsp.FormattingOptions): lsp.TextEdit[] {

        let parsedDoc = this.docStore.find(doc.uri);

        if (!parsedDoc) {
            return [];
        }

        let visitor = new FormatVisitor(parsedDoc, formatOptions, range);
        parsedDoc.traverse(visitor);
        return visitor.edits;

    }

    private _isCloseTag(t: Token) {
        return t.kind === TokenKind.CloseTag;
    }

}

class FormatVisitor implements TreeVisitor<Phrase | Token> {

    private _edits: lsp.TextEdit[];
    private _previousToken: Token;
    private _previousNonWsToken: Token;
    private _nextFormatRule: FormatRule;
    private _isMultilineCommaDelimitedListStack: boolean[];
    private _indentUnit: string;
    private _indentText = '';
    private static _docBlockRegex = /(?:\r\n|\r|\n)[ \t]*\*/g;
    private _startOffset = -1;
    private _endOffset = -1;
    private _active = true;
    private _lastParameterListWasMultiLine = false;

    private static memberAccessExprTypes = [
        PhraseKind.MethodCallExpression, PhraseKind.PropertyAccessExpression, 
        PhraseKind.ScopedCallExpression, PhraseKind.ClassConstantAccessExpression, PhraseKind.ScopedPropertyAccessExpression
    ];

    private _decrementOnTheseNodes:Phrase[];

    firstToken: Token;
    last3Tokens: Token[];
    OpenTagCount = 0;

    haltTraverse: boolean;

    constructor(
        public doc: ParsedDocument,
        public formatOptions: lsp.FormattingOptions,
        range?: lsp.Range) {
        this._edits = [];
        this._isMultilineCommaDelimitedListStack = [];
        this._indentUnit = formatOptions.insertSpaces ? FormatVisitor.createWhitespace(formatOptions.tabSize, ' ') : '\t';
        if (range) {
            this._startOffset = this.doc.offsetAtPosition(range.start);
            this._endOffset = this.doc.offsetAtPosition(range.end);
            this._active = false;
        }
        this.last3Tokens = [];
        this._decrementOnTheseNodes = [];
    }

    get edits() {
        return this._edits.reverse();
    }

    preorder(node: Phrase | Token, spine: (Phrase | Token)[]) {

        let parent = spine.length ? <Phrase>spine[spine.length - 1] : <Phrase>{ kind: PhraseKind.Unknown, children: [] };

        if (isPhrase(node)) {
            switch (node.kind) {
    
                //newline indent before {
                case PhraseKind.FunctionDeclarationBody:
                    if (parent.kind === PhraseKind.AnonymousFunctionCreationExpression || this._lastParameterListWasMultiLine) {
                        this._nextFormatRule = FormatVisitor.singleSpaceBefore;
                        this._lastParameterListWasMultiLine = false;
                    } else {
                        this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                    }
                    return true;
    
                case PhraseKind.MethodDeclarationBody:
                    if(this._lastParameterListWasMultiLine) {
                        this._nextFormatRule = FormatVisitor.singleSpaceBefore;
                        this._lastParameterListWasMultiLine = false;
                    } else {
                        this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                    }
    
                    return true;
    
                case PhraseKind.ClassDeclarationBody:
                case PhraseKind.TraitDeclarationBody:
                case PhraseKind.InterfaceDeclarationBody:
                    this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                    return true;
    
                //comma delim lists
                case PhraseKind.ParameterDeclarationList:
                case PhraseKind.ArgumentExpressionList:
                case PhraseKind.ClosureUseList:
                case PhraseKind.ArrayInitialiserList:
                case PhraseKind.QualifiedNameList:
                    if (
                        (this._previousToken &&
                            this._previousToken.kind === TokenKind.Whitespace &&
                            FormatVisitor.countNewlines(this.doc.tokenText(this._previousToken)) > 0) ||
                        this._hasNewlineWhitespaceChild(<Phrase>node)
                    ) {
                        this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                        this._isMultilineCommaDelimitedListStack.push(true);
                        this._incrementIndent();
                    } else {
                        this._isMultilineCommaDelimitedListStack.push(false);
                        if ((<Phrase>node).kind !== PhraseKind.QualifiedNameList) {
                            this._nextFormatRule = FormatVisitor.noSpaceBefore;
                        }
                    }
                    return true;
    
                case PhraseKind.ConstElementList:
                case PhraseKind.ClassConstElementList:
                case PhraseKind.PropertyElementList:
                case PhraseKind.StaticVariableDeclarationList:
                case PhraseKind.VariableNameList:
                    if (
                        (this._previousToken &&
                            this._previousToken.kind === TokenKind.Whitespace &&
                            FormatVisitor.countNewlines(this.doc.tokenText(this._previousToken)) > 0) ||
                        this._hasNewlineWhitespaceChild(<Phrase>node)
                    ) {
                        this._isMultilineCommaDelimitedListStack.push(true);
                        this._incrementIndent();
                    } else {
                        this._isMultilineCommaDelimitedListStack.push(false);
                    }
                    this._nextFormatRule = FormatVisitor.singleSpaceOrNewlineIndentBefore;
                    return true;
    
                case PhraseKind.EncapsulatedVariableList:
                    this._nextFormatRule = FormatVisitor.noSpaceBefore;
                    return true;
    
                case PhraseKind.SimpleVariable:
                    if (parent.kind === PhraseKind.EncapsulatedVariableList) {
                        this._nextFormatRule = FormatVisitor.noSpaceBefore;
                    }
                    return true;
    
                default:
                    if (parent.kind === PhraseKind.EncapsulatedVariableList) {
                        this._nextFormatRule = FormatVisitor.noSpaceBefore;
                    }
                    return true;
            }
        }

        let rule = this._nextFormatRule;
        let previous = this._previousToken;
        let previousNonWsToken = this._previousNonWsToken;
        this._previousToken = node as Token;
        if (this._previousToken.kind !== TokenKind.Whitespace) {
            this._previousNonWsToken = this._previousToken;
        }

        if (!this.firstToken) {
            this.firstToken = this._previousToken;
        }

        this.last3Tokens.push(this._previousToken);
        if (this.last3Tokens.length > 3) {
            this.last3Tokens.shift();
        }

        if (this._previousToken.kind === TokenKind.OpenTag || this._previousToken.kind === TokenKind.OpenTagEcho) {
            this.OpenTagCount++;
        }

        this._nextFormatRule = null;

        if (!this._active && this._startOffset > -1 && ParsedDocument.isOffsetInNode(this._startOffset, <Token>node)) {
            this._active = true;
        }

        if (!previous) {
            return false;
        }

        switch (node.kind) {

            case TokenKind.Whitespace:
                this._nextFormatRule = rule;
                return false;

            case TokenKind.Comment:
                return false;

            case TokenKind.DocumentComment:
                rule = FormatVisitor.newlineIndentBefore;
                break;

            case TokenKind.PlusPlus:
                if (parent.kind === PhraseKind.PostfixIncrementExpression) {
                    rule = FormatVisitor.noSpaceBefore;
                }
                break;

            case TokenKind.MinusMinus:
                if (parent.kind === PhraseKind.PostfixDecrementExpression) {
                    rule = FormatVisitor.noSpaceBefore;
                }
                break;

            case TokenKind.Backslash:
                if (parent.kind === PhraseKind.NamespaceName) {
                    rule = FormatVisitor.noSpaceBefore;
                }
                break;

            case TokenKind.Semicolon:
            case TokenKind.Comma:
            case TokenKind.Text:
            case TokenKind.EncapsulatedAndWhitespace:
            case TokenKind.DollarCurlyOpen:
            case TokenKind.CurlyOpen:
                rule = FormatVisitor.noSpaceBefore;
                break;

            case TokenKind.OpenBrace:
                if(previousNonWsToken && previousNonWsToken.kind === TokenKind.Dollar) {
                    rule = FormatVisitor.noSpaceBefore;
                } else if(!rule) {
                    rule = FormatVisitor.singleSpaceBefore;
                }
                break;

            case TokenKind.Colon:
                if(parent.kind === PhraseKind.CaseStatement || parent.kind === PhraseKind.DefaultStatement) {
                    rule = FormatVisitor.noSpaceBefore;
                }
                break;

            case TokenKind.OpenTag:
            case TokenKind.OpenTagEcho:
                rule = FormatVisitor.noSpaceBefore;
                this._indentText = FormatVisitor.createWhitespace(
                    Math.ceil((this.doc.lineSubstring((<Token>node).offset).length - 1) / this._indentUnit.length),
                    this._indentUnit
                );
                break;

            case TokenKind.Else:
            case TokenKind.ElseIf:
                if (previousNonWsToken && previousNonWsToken.kind === TokenKind.CloseBrace) {
                    rule = FormatVisitor.singleSpaceBefore;
                }
                break;

            case TokenKind.Name:
                if(parent.kind === PhraseKind.PropertyAccessExpression || previousNonWsToken.kind === TokenKind.Backslash) {
                    rule = FormatVisitor.noSpaceBefore;
                }
                break;

            case TokenKind.While:
                if (parent.kind === PhraseKind.DoStatement) {
                    rule = FormatVisitor.singleSpaceBefore;
                }
                break;

            case TokenKind.Catch:
                rule = FormatVisitor.singleSpaceBefore;
                break;

            case TokenKind.Arrow:
            case TokenKind.ColonColon:
                if(previous && previous.kind === TokenKind.Whitespace && FormatVisitor.countNewlines(this.doc.tokenText(previous)) > 0) {
                    //get the outer member access expr
                    let outerExpr = parent;
                    for(let n = spine.length - 2; n >= 0; --n) {
                        if(ParsedDocument.isPhrase(spine[n], FormatVisitor.memberAccessExprTypes)) {
                            outerExpr = spine[n] as Phrase;
                        } else {
                            break;
                        }
                    }
                    if(!this._decrementOnTheseNodes.find((x)=>{ return x === outerExpr})) {
                        this._decrementOnTheseNodes.push(outerExpr);
                        this._incrementIndent();
                    }
                }
                rule = FormatVisitor.noSpaceOrNewlineIndentBefore;
                break;

            case TokenKind.OpenParenthesis:
                if (this._shouldOpenParenthesisHaveNoSpaceBefore(parent, previousNonWsToken)) {
                    rule = FormatVisitor.noSpaceBefore;
                } else if(!rule) {
                    rule = FormatVisitor.singleSpaceBefore;
                }
                break;

            case TokenKind.OpenBracket:
                if (parent.kind === PhraseKind.SubscriptExpression) {
                    rule = FormatVisitor.noSpaceBefore;
                }
                break;

            case TokenKind.CloseBrace:
                this._decrementIndent();
                if (
                    parent.kind === PhraseKind.SubscriptExpression ||
                    parent.kind === PhraseKind.EncapsulatedExpression ||
                    parent.kind === PhraseKind.EncapsulatedVariable
                ) {
                    rule = FormatVisitor.noSpaceBefore;
                } else {
                    rule = FormatVisitor.newlineIndentBefore;
                }
                break;

            case TokenKind.CloseBracket:
            case TokenKind.CloseParenthesis:
                if (!rule) {
                    rule = FormatVisitor.noSpaceBefore;
                }
                break;

            case TokenKind.CloseTag:
                if (previous.kind === TokenKind.Comment && this.doc.tokenText(previous).slice(0, 2) !== '/*') {
                    rule = FormatVisitor.noSpaceBefore;
                } else if (rule !== FormatVisitor.indentOrNewLineIndentBefore) {
                    rule = FormatVisitor.singleSpaceOrNewlineIndentBefore;
                }
                break;

            default:
                break;
        }

        if (!rule) {
            rule = FormatVisitor.singleSpaceOrNewlineIndentPlusOneBefore;
        }

        if (!this._active) {
            return false;
        }

        let edit = rule(previous, this.doc, this._indentText, this._indentUnit);
        if (edit) {
            this._edits.push(edit);
        }

        //keywords should be lowercase
        if (this._isKeyword(<Token>node)) {
            let text = this.doc.tokenText(<Token>node);
            let lcText = text.toLowerCase();
            if (text !== lcText) {
                this._edits.push(lsp.TextEdit.replace(this.doc.tokenRange(<Token>node), lcText));
            }
        } else if(this._isTrueFalseNull(<Token>node, spine)) {
            let text = this.doc.tokenText(<Token>node);
            let lcText = text.toLowerCase();
            if (text !== lcText) {
                this._edits.push(lsp.TextEdit.replace(this.doc.tokenRange(<Token>node), lcText));
            }
        }

        return false;
    }

    postorder(node: Phrase | Token, spine: (Phrase | Token)[]) {

        let parent = spine[spine.length - 1] as Phrase;

        let decrementOnNode = this._decrementOnTheseNodes.length ? this._decrementOnTheseNodes[this._decrementOnTheseNodes.length - 1] : undefined;
        if(decrementOnNode === node) {
            this._decrementIndent();
            this._decrementOnTheseNodes.pop();
        }

        if (isPhrase(node)) {
            switch (node.kind) {
                case PhraseKind.CaseStatement:
                case PhraseKind.DefaultStatement:
                    this._decrementIndent();
                    return;
    
                case PhraseKind.NamespaceDefinition:
                    this._nextFormatRule = FormatVisitor.doubleNewlineIndentBefore;
                    return;
    
                case PhraseKind.NamespaceUseDeclaration:
                    if (this._isLastNamespaceUseDeclaration(parent, <Phrase>node)) {
                        this._nextFormatRule = FormatVisitor.doubleNewlineIndentBefore;
                    }
                    return;
    
                case PhraseKind.ParameterDeclarationList:
                case PhraseKind.ArgumentExpressionList:
                case PhraseKind.ClosureUseList:
                case PhraseKind.QualifiedNameList:
                case PhraseKind.ArrayInitialiserList:
                    if (this._isMultilineCommaDelimitedListStack.pop()) {
                        this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                        this._decrementIndent();
                        if((<Phrase>node).kind === PhraseKind.ParameterDeclarationList) {
                            this._lastParameterListWasMultiLine = true;
                        }
                    }
                    return;
    
                case PhraseKind.ConstElementList:
                case PhraseKind.PropertyElementList:
                case PhraseKind.ClassConstElementList:
                case PhraseKind.StaticVariableDeclarationList:
                case PhraseKind.VariableNameList:
                    if (this._isMultilineCommaDelimitedListStack.pop()) {
                        this._decrementIndent();
                    }
                    return;
    
                case PhraseKind.EncapsulatedVariableList:
                    this._nextFormatRule = FormatVisitor.noSpaceBefore;
                    return;
    
                case PhraseKind.AnonymousFunctionCreationExpression:
                    this._nextFormatRule = null;
                    break;
    
                default:
                    return;
            }
        } else {
            switch (node.kind) {
    
                case TokenKind.Comment:
                    if (this.doc.tokenText(<Token>node).slice(0, 2) === '/*') {
                        this._nextFormatRule = FormatVisitor.singleSpaceOrNewlineIndentBefore;
                        if (this._active) {
                            let edit = this._formatDocBlock(<Token>node);
                            if (edit) {
                                this._edits.push(edit);
                            }
                        }
    
                    } else {
                        this._nextFormatRule = FormatVisitor.indentOrNewLineIndentBefore;
                    }
                    break;
    
                case TokenKind.DocumentComment:
                    this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                    if (!this._active) {
                        break;
                    }
                    let edit = this._formatDocBlock(<Token>node);
                    if (edit) {
                        this._edits.push(edit);
                    }
                    break;
    
                case TokenKind.OpenBrace:
                    if (parent.kind === PhraseKind.EncapsulatedExpression) {
                        this._nextFormatRule = FormatVisitor.noSpaceBefore;
                    } else {
                        this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                    }
    
                    this._incrementIndent();
                    break;
    
                case TokenKind.CloseBrace:
                    if (parent.kind !== PhraseKind.EncapsulatedVariable &&
                        parent.kind !== PhraseKind.EncapsulatedExpression &&
                        parent.kind !== PhraseKind.SubscriptExpression
                    ) {
                        this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                    }
                    break;
    
                case TokenKind.Semicolon:
                    if (parent.kind === PhraseKind.ForStatement) {
                        this._nextFormatRule = FormatVisitor.singleSpaceBefore;
                    } else {
                        this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                    }
                    break;
    
                case TokenKind.Colon:
                    if (this._shouldIndentAfterColon(<Phrase>spine[spine.length - 1])) {
                        this._incrementIndent();
                        this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                    }
    
                    break;
    
                case TokenKind.Ampersand:
                    if (parent.kind !== PhraseKind.BitwiseExpression) {
                        this._nextFormatRule = FormatVisitor.noSpaceBefore;
                    }
                    break;
    
                case TokenKind.Plus:
                case TokenKind.Minus:
                    if (parent.kind === PhraseKind.UnaryOpExpression) {
                        this._nextFormatRule = FormatVisitor.noSpaceBefore;
                    }
                    break;
    
                case TokenKind.PlusPlus:
                    if (parent.kind === PhraseKind.PrefixIncrementExpression) {
                        this._nextFormatRule = FormatVisitor.noSpaceBefore;
                    }
                    break;
    
                case TokenKind.MinusMinus:
                    if (parent.kind === PhraseKind.PrefixDecrementExpression) {
                        this._nextFormatRule = FormatVisitor.noSpaceBefore;
                    }
                    break;
    
                case TokenKind.Ellipsis:
                case TokenKind.Exclamation:
                case TokenKind.AtSymbol:
                case TokenKind.ArrayCast:
                case TokenKind.BooleanCast:
                case TokenKind.FloatCast:
                case TokenKind.IntegerCast:
                case TokenKind.ObjectCast:
                case TokenKind.StringCast:
                case TokenKind.UnsetCast:
                case TokenKind.Tilde:
                case TokenKind.Backslash:
                case TokenKind.OpenParenthesis:
                case TokenKind.OpenBracket:
                    this._nextFormatRule = FormatVisitor.noSpaceBefore;
                    break;
    
                case TokenKind.CurlyOpen:
                case TokenKind.DollarCurlyOpen:
                    this._incrementIndent();
                    this._nextFormatRule = FormatVisitor.noSpaceBefore;
                    break;
    
                case TokenKind.Comma:
                    if (
                        parent.kind === PhraseKind.ArrayInitialiserList ||
                        parent.kind === PhraseKind.ConstElementList ||
                        parent.kind === PhraseKind.ClassConstElementList ||
                        parent.kind === PhraseKind.PropertyElementList ||
                        parent.kind === PhraseKind.StaticVariableDeclarationList ||
                        parent.kind === PhraseKind.VariableNameList
                    ) {
                        this._nextFormatRule = FormatVisitor.singleSpaceOrNewlineIndentBefore;
                    } else if (
                        this._isMultilineCommaDelimitedListStack.length > 0 &&
                        this._isMultilineCommaDelimitedListStack[this._isMultilineCommaDelimitedListStack.length - 1]
                    ) {
                        this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                    }
                    break;
    
                case TokenKind.Arrow:
                case TokenKind.ColonColon:
                    this._nextFormatRule = FormatVisitor.noSpaceBefore;
                    break;
    
                case TokenKind.OpenTag:
                    let tagText = this.doc.tokenText(<Token>node);
                    if (tagText.length > 2) {
                        if (FormatVisitor.countNewlines(tagText) > 0) {
                            this._nextFormatRule = FormatVisitor.indentOrNewLineIndentBefore;
                        } else {
                            this._nextFormatRule = FormatVisitor.noSpaceOrNewlineIndentBefore;
                        }
                        break;
                    }
    
                //fall through
                case TokenKind.OpenTagEcho:
                    this._nextFormatRule = FormatVisitor.singleSpaceOrNewlineIndentBefore;
                    break;
    
                default:
                    break;
    
            }
        }

        if (this._active && this._endOffset > -1 && ParsedDocument.isOffsetInNode(this._endOffset, <Token>node)) {
            this.haltTraverse = true;
            this._active = false;
        }

    }

    private _isTrueFalseNull(node:Token, spine:(Phrase|Token)[]) {
        let parent = spine.length ? spine[spine.length - 1] : undefined;
        let greatGrandParent = spine.length > 2 ? spine[spine.length - 3] : undefined;
        const keywords = ['true', 'false', 'null'];
        return ParsedDocument.isToken(node, [TokenKind.Name]) && 
            ParsedDocument.isPhrase(parent, [PhraseKind.NamespaceName]) &&
            (<Phrase>parent).children.length === 1 &&
            ParsedDocument.isPhrase(greatGrandParent, [PhraseKind.ConstantAccessExpression]) &&
            keywords.indexOf(this.doc.tokenText(node).toLowerCase()) > -1;
    }

    private _formatDocBlock(node: Token) {
        let text = this.doc.tokenText(node);
        let formatted = text.replace(FormatVisitor._docBlockRegex, '\n' + this._indentText + ' *');
        return formatted !== text ? lsp.TextEdit.replace(this.doc.tokenRange(node), formatted) : null;
    }

    private _incrementIndent() {
        this._indentText += this._indentUnit;
    }

    private _decrementIndent() {
        this._indentText = this._indentText.slice(0, -this._indentUnit.length);
    }

    private _hasNewlineWhitespaceChild(phrase: Phrase) {
        for (let n = 0, l = phrase.children.length; n < l; ++n) {
            if (
                (<Token>phrase.children[n]).kind === TokenKind.Whitespace &&
                FormatVisitor.countNewlines(this.doc.tokenText(<Token>phrase.children[n])) > 0
            ) {
                return true;
            }
        }
        return false;
    }

    private _isLastNamespaceUseDeclaration(parent: Phrase, child: Phrase) {

        let i = parent.children.indexOf(child);
        while (i < parent.children.length) {
            ++i;
            child = parent.children[i] as Phrase;
            if (child.kind) {
                return child.kind !== PhraseKind.NamespaceUseDeclaration;
            }
        }

        return true;

    }

    private _shouldIndentAfterColon(parent: Phrase) {
        switch (parent.kind) {
            case PhraseKind.CaseStatement:
            case PhraseKind.DefaultStatement:
                return true;
            default:
                return false;
        }
    }

    private _shouldOpenParenthesisHaveNoSpaceBefore(parent: Phrase, lastNonWsToken:Token) {
        switch (parent.kind) {
            case PhraseKind.FunctionCallExpression:
            case PhraseKind.MethodCallExpression:
            case PhraseKind.ScopedCallExpression:
            case PhraseKind.EchoIntrinsic:
            case PhraseKind.EmptyIntrinsic:
            case PhraseKind.EvalIntrinsic:
            case PhraseKind.ExitIntrinsic:
            case PhraseKind.IssetIntrinsic:
            case PhraseKind.ListIntrinsic:
            case PhraseKind.PrintIntrinsic:
            case PhraseKind.UnsetIntrinsic:
            case PhraseKind.ArrayCreationExpression:
            case PhraseKind.FunctionDeclarationHeader:
            case PhraseKind.MethodDeclarationHeader:
            case PhraseKind.ObjectCreationExpression:
            case PhraseKind.RequireExpression:
            case PhraseKind.RequireOnceExpression:
            case PhraseKind.IncludeExpression:
            case PhraseKind.IncludeOnceExpression:
                return true;
            default:
                if(!lastNonWsToken) {
                    return false;
                }
                break;
        }

        switch(lastNonWsToken.kind) {
            case TokenKind.Require:
            case TokenKind.RequireOnce:
            case TokenKind.Include:
            case TokenKind.IncludeOnce:
            case TokenKind.Isset:
            case TokenKind.List:
            case TokenKind.Print:
            case TokenKind.Unset:
            case TokenKind.Eval:
            case TokenKind.Exit:
            case TokenKind.Empty:
                return true;
            default:
                return false;
        }
        
    }

    private _hasColonChild(phrase: Phrase) {

        for (let n = 0, l = phrase.children.length; n < l; ++n) {
            if ((<Token>phrase.children[n]).kind === TokenKind.Colon) {
                return true;
            }
        }
        return false;

    }

    private _isKeyword(t: Token) {
        if (!t) {
            return false;
        }
        switch (t.kind) {
            case TokenKind.Abstract:
            case TokenKind.Array:
            case TokenKind.As:
            case TokenKind.Break:
            case TokenKind.Callable:
            case TokenKind.Case:
            case TokenKind.Catch:
            case TokenKind.Class:
            case TokenKind.ClassConstant:
            case TokenKind.Clone:
            case TokenKind.Const:
            case TokenKind.Continue:
            case TokenKind.Declare:
            case TokenKind.Default:
            case TokenKind.Do:
            case TokenKind.Echo:
            case TokenKind.Else:
            case TokenKind.ElseIf:
            case TokenKind.Empty:
            case TokenKind.EndDeclare:
            case TokenKind.EndFor:
            case TokenKind.EndForeach:
            case TokenKind.EndIf:
            case TokenKind.EndSwitch:
            case TokenKind.EndWhile:
            case TokenKind.Eval:
            case TokenKind.Exit:
            case TokenKind.Extends:
            case TokenKind.Final:
            case TokenKind.Finally:
            case TokenKind.For:
            case TokenKind.ForEach:
            case TokenKind.Function:
            case TokenKind.Global:
            case TokenKind.Goto:
            case TokenKind.HaltCompiler:
            case TokenKind.If:
            case TokenKind.Implements:
            case TokenKind.Include:
            case TokenKind.IncludeOnce:
            case TokenKind.InstanceOf:
            case TokenKind.InsteadOf:
            case TokenKind.Interface:
            case TokenKind.Isset:
            case TokenKind.List:
            case TokenKind.And:
            case TokenKind.Or:
            case TokenKind.Xor:
            case TokenKind.Namespace:
            case TokenKind.New:
            case TokenKind.Print:
            case TokenKind.Private:
            case TokenKind.Public:
            case TokenKind.Protected:
            case TokenKind.Require:
            case TokenKind.RequireOnce:
            case TokenKind.Return:
            case TokenKind.Static:
            case TokenKind.Switch:
            case TokenKind.Throw:
            case TokenKind.Trait:
            case TokenKind.Try:
            case TokenKind.Unset:
            case TokenKind.Use:
            case TokenKind.Var:
            case TokenKind.While:
            case TokenKind.Yield:
            case TokenKind.YieldFrom:
                return true;
            default:
                return false;
        }
    }

}

namespace FormatVisitor {

    export function singleSpaceBefore(previous: Token, doc: ParsedDocument, indentText: string, indentUnit: string): lsp.TextEdit {
        if (previous.kind !== TokenKind.Whitespace) {
            return lsp.TextEdit.insert(doc.positionAtOffset(previous.offset + previous.length), ' ');
        }

        let actualWs = doc.tokenText(previous);
        let expectedWs = ' ';
        if (actualWs === expectedWs) {
            return null;
        }
        return lsp.TextEdit.replace(doc.tokenRange(previous), expectedWs);
    }

    export function indentBefore(previous: Token, doc: ParsedDocument, indentText: string, indentUnit: string): lsp.TextEdit {
        if (previous.kind !== TokenKind.Whitespace) {
            return indentText ? lsp.TextEdit.insert(doc.positionAtOffset(previous.offset + previous.length), indentText) : null;
        }

        if (!indentText) {
            return lsp.TextEdit.del(doc.tokenRange(previous));
        }

        let actualWs = doc.tokenText(previous);
        if (actualWs === indentText) {
            return null;
        }
        return lsp.TextEdit.replace(doc.tokenRange(previous), indentText);
    }

    export function indentOrNewLineIndentBefore(previous: Token, doc: ParsedDocument, indentText: string, indentUnit: string): lsp.TextEdit {
        if (previous.kind !== TokenKind.Whitespace) {
            return indentText ? lsp.TextEdit.insert(doc.positionAtOffset(previous.offset + previous.length), indentText) : null;
        }

        let actualWs = doc.tokenText(previous);
        let nl = countNewlines(actualWs);
        if (nl) {
            let expectedWs = createWhitespace(Math.max(1, nl), '\n') + indentText;
            if (actualWs === expectedWs) {
                return null;
            }
            return lsp.TextEdit.replace(doc.tokenRange(previous), expectedWs);
        }

        if (!indentText) {
            return lsp.TextEdit.del(doc.tokenRange(previous));
        }

        if (actualWs === indentText) {
            return null;
        }
        return lsp.TextEdit.replace(doc.tokenRange(previous), indentText);
    }

    export function newlineIndentBefore(previous: Token, doc: ParsedDocument, indentText: string, indentUnit: string): lsp.TextEdit {
        if (previous.kind !== TokenKind.Whitespace) {
            return lsp.TextEdit.insert(doc.positionAtOffset(previous.offset + previous.length), '\n' + indentText);
        }

        let actualWs = doc.tokenText(previous);
        let expectedWs = createWhitespace(Math.max(1, countNewlines(actualWs)), '\n') + indentText;
        if (actualWs === expectedWs) {
            return null;
        }
        return lsp.TextEdit.replace(doc.tokenRange(previous), expectedWs);
    }

    export function doubleNewlineIndentBefore(previous: Token, doc: ParsedDocument, indentText: string, indentUnit: string): lsp.TextEdit {
        if (previous.kind !== TokenKind.Whitespace) {
            return lsp.TextEdit.insert(doc.positionAtOffset(previous.offset + previous.length), '\n\n' + indentText);
        }

        let actualWs = doc.tokenText(previous);
        let expected = createWhitespace(Math.max(2, countNewlines(actualWs)), '\n') + indentText;
        if (actualWs === expected) {
            return null;
        }
        return lsp.TextEdit.replace(doc.tokenRange(previous), expected);
    }

    export function noSpaceBefore(previous: Token, doc: ParsedDocument, indentText: string, indentUnit: string): lsp.TextEdit {
        if (previous.kind !== TokenKind.Whitespace) {
            return null;
        }
        return lsp.TextEdit.del(doc.tokenRange(previous));
    }

    export function noSpaceOrNewlineIndentPlusOneBefore(previous: Token, doc: ParsedDocument, indentText: string, indentUnit: string): lsp.TextEdit {
        if (previous.kind !== TokenKind.Whitespace) {
            return null;
        }

        let actualWs = doc.tokenText(previous);
        let newlineCount = countNewlines(actualWs);
        if (!newlineCount) {
            return lsp.TextEdit.del(doc.tokenRange(previous));
        }

        let expectedWs = createWhitespace(newlineCount, '\n') + indentText + indentUnit;
        if (actualWs === expectedWs) {
            return null;
        }
        return lsp.TextEdit.replace(doc.tokenRange(previous), expectedWs);

    }

    export function noSpaceOrNewlineIndentBefore(previous: Token, doc: ParsedDocument, indentText: string, indentUnit: string): lsp.TextEdit {
        if (previous.kind !== TokenKind.Whitespace) {
            return null;
        }

        let actualWs = doc.tokenText(previous);
        let newlineCount = countNewlines(actualWs);
        if (!newlineCount) {
            return lsp.TextEdit.del(doc.tokenRange(previous));
        }

        let expectedWs = createWhitespace(newlineCount, '\n') + indentText;
        if (actualWs === expectedWs) {
            return null;
        }
        return lsp.TextEdit.replace(doc.tokenRange(previous), expectedWs);

    }

    export function singleSpaceOrNewlineIndentPlusOneBefore(previous: Token, doc: ParsedDocument, indentText: string, indentUnit: string): lsp.TextEdit {

        if (previous.kind !== TokenKind.Whitespace) {
            return lsp.TextEdit.insert(doc.positionAtOffset(previous.offset + previous.length), ' ');
        }

        let actualWs = doc.tokenText(previous);
        if (actualWs === ' ') {
            return null;
        }

        let newlineCount = countNewlines(actualWs);
        if (!newlineCount) {
            return lsp.TextEdit.replace(doc.tokenRange(previous), ' ');
        }

        let expectedWs = createWhitespace(newlineCount, '\n') + indentText + indentUnit;
        if (actualWs !== expectedWs) {
            return lsp.TextEdit.replace(doc.tokenRange(previous), expectedWs);
        }

        return null;

    }

    export function singleSpaceOrNewlineIndentBefore(previous: Token, doc: ParsedDocument, indentText: string, indentUnit: string): lsp.TextEdit {

        if (previous.kind !== TokenKind.Whitespace) {
            return lsp.TextEdit.insert(doc.positionAtOffset(previous.offset + previous.length), ' ');
        }

        let actualWs = doc.tokenText(previous);
        if (actualWs === ' ') {
            return null;
        }

        let newlineCount = countNewlines(actualWs);
        if (!newlineCount) {
            return lsp.TextEdit.replace(doc.tokenRange(previous), ' ');
        }

        let expectedWs = createWhitespace(newlineCount, '\n') + indentText;
        if (actualWs !== expectedWs) {
            return lsp.TextEdit.replace(doc.tokenRange(previous), expectedWs);
        }

        return null;

    }

    export function createWhitespace(n: number, unit: string) {
        let text = '';
        while (n > 0) {
            text += unit;
            --n;
        }
        return text;
    }

    export function countNewlines(text: string) {

        let c: string;
        let count = 0;
        let l = text.length;
        let n = 0;

        while (n < l) {
            c = text[n];
            ++n;
            if (c === '\r') {
                ++count;
                if (n < l && text[n] === '\n') {
                    ++n;
                }
            } else if (c === '\n') {
                ++count;
            }

        }

        return count;

    }

}
