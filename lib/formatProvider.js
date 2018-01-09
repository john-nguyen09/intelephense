/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const lsp = require("vscode-languageserver-types");
const parsedDocument_1 = require("./parsedDocument");
class FormatProvider {
    constructor(docStore) {
        this.docStore = docStore;
    }
    provideDocumentFormattingEdits(doc, formatOptions) {
        let parsedDoc = this.docStore.find(doc.uri);
        if (!parsedDoc) {
            return [];
        }
        let visitor = new FormatVisitor(parsedDoc, formatOptions);
        parsedDoc.traverse(visitor);
        let edits = visitor.edits;
        let text = parsedDoc.text;
        if (visitor.firstToken &&
            visitor.firstToken.tokenType === 156 /* OpenTag */ &&
            visitor.OpenTagCount === 1) {
            //must omit close tag if php only and end in blank line
            let closeTagIndex = visitor.last3Tokens.findIndex(this._isCloseTag);
            let endEdit;
            let lastToken = visitor.last3Tokens.length ? visitor.last3Tokens[visitor.last3Tokens.length - 1] : undefined;
            let lastTokenText = parsedDoc.tokenText(lastToken);
            if (closeTagIndex < 0) {
                //last token should be \n\n
                if (lastToken && lastToken.tokenType === 161 /* Whitespace */ && lastTokenText.search(FormatProvider.blkLinePattern) < 0) {
                    endEdit = lsp.TextEdit.replace(parsedDoc.tokenRange(lastToken), '\n\n');
                }
                else if (lastToken && lastToken.tokenType !== 161 /* Whitespace */) {
                    endEdit = lsp.TextEdit.insert(parsedDoc.tokenRange(lastToken).end, '\n\n');
                }
            }
            else if (closeTagIndex > 0 && (lastToken.tokenType === 158 /* CloseTag */ || (lastToken.tokenType === 81 /* Text */ && !lastTokenText.trim()))) {
                let tokenBeforeClose = visitor.last3Tokens[closeTagIndex - 1];
                let replaceStart;
                if (tokenBeforeClose.tokenType === 161 /* Whitespace */) {
                    replaceStart = parsedDoc.tokenRange(tokenBeforeClose).start;
                }
                else {
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
            if (endEdit) {
                edits.unshift(endEdit);
            }
        }
        return edits;
    }
    provideDocumentRangeFormattingEdits(doc, range, formatOptions) {
        let parsedDoc = this.docStore.find(doc.uri);
        if (!parsedDoc) {
            return [];
        }
        let visitor = new FormatVisitor(parsedDoc, formatOptions, range);
        parsedDoc.traverse(visitor);
        return visitor.edits;
    }
    _isCloseTag(t) {
        return t.tokenType === 158 /* CloseTag */;
    }
}
FormatProvider.blkLinePattern = /^(\r\n|\r|\n){2}$/;
exports.FormatProvider = FormatProvider;
class FormatVisitor {
    constructor(doc, formatOptions, range) {
        this.doc = doc;
        this.formatOptions = formatOptions;
        this._indentText = '';
        this._startOffset = -1;
        this._endOffset = -1;
        this._active = true;
        this._lastParameterListWasMultiLine = false;
        this.OpenTagCount = 0;
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
    preorder(node, spine) {
        let parent = spine.length ? spine[spine.length - 1] : { phraseType: 0 /* Unknown */, children: [] };
        switch (node.phraseType) {
            //newline indent before {
            case 87 /* FunctionDeclarationBody */:
                if (parent.phraseType === 4 /* AnonymousFunctionCreationExpression */ || this._lastParameterListWasMultiLine) {
                    this._nextFormatRule = FormatVisitor.singleSpaceBefore;
                    this._lastParameterListWasMultiLine = false;
                }
                else {
                    this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                }
                return true;
            case 114 /* MethodDeclarationBody */:
                if (this._lastParameterListWasMultiLine) {
                    this._nextFormatRule = FormatVisitor.singleSpaceBefore;
                    this._lastParameterListWasMultiLine = false;
                }
                else {
                    this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                }
                return true;
            case 29 /* ClassDeclarationBody */:
            case 166 /* TraitDeclarationBody */:
            case 104 /* InterfaceDeclarationBody */:
                this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                return true;
            //comma delim lists
            case 130 /* ParameterDeclarationList */:
            case 8 /* ArgumentExpressionList */:
            case 36 /* ClosureUseList */:
            case 11 /* ArrayInitialiserList */:
            case 142 /* QualifiedNameList */:
                if ((this._previousToken &&
                    this._previousToken.tokenType === 161 /* Whitespace */ &&
                    FormatVisitor.countNewlines(this.doc.tokenText(this._previousToken)) > 0) ||
                    this._hasNewlineWhitespaceChild(node)) {
                    this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                    this._isMultilineCommaDelimitedListStack.push(true);
                    this._incrementIndent();
                }
                else {
                    this._isMultilineCommaDelimitedListStack.push(false);
                    if (node.phraseType !== 142 /* QualifiedNameList */) {
                        this._nextFormatRule = FormatVisitor.noSpaceBefore;
                    }
                }
                return true;
            case 44 /* ConstElementList */:
            case 27 /* ClassConstElementList */:
            case 139 /* PropertyElementList */:
            case 159 /* StaticVariableDeclarationList */:
            case 177 /* VariableNameList */:
                if ((this._previousToken &&
                    this._previousToken.tokenType === 161 /* Whitespace */ &&
                    FormatVisitor.countNewlines(this.doc.tokenText(this._previousToken)) > 0) ||
                    this._hasNewlineWhitespaceChild(node)) {
                    this._isMultilineCommaDelimitedListStack.push(true);
                    this._incrementIndent();
                }
                else {
                    this._isMultilineCommaDelimitedListStack.push(false);
                }
                this._nextFormatRule = FormatVisitor.singleSpaceOrNewlineIndentBefore;
                return true;
            case 58 /* EncapsulatedVariableList */:
                this._nextFormatRule = FormatVisitor.noSpaceBefore;
                return true;
            case 156 /* SimpleVariable */:
                if (parent.phraseType === 58 /* EncapsulatedVariableList */) {
                    this._nextFormatRule = FormatVisitor.noSpaceBefore;
                }
                return true;
            case undefined:
                //tokens
                break;
            default:
                if (parent.phraseType === 58 /* EncapsulatedVariableList */) {
                    this._nextFormatRule = FormatVisitor.noSpaceBefore;
                }
                return true;
        }
        let rule = this._nextFormatRule;
        let previous = this._previousToken;
        let previousNonWsToken = this._previousNonWsToken;
        this._previousToken = node;
        if (this._previousToken.tokenType !== 161 /* Whitespace */) {
            this._previousNonWsToken = this._previousToken;
        }
        if (!this.firstToken) {
            this.firstToken = this._previousToken;
        }
        this.last3Tokens.push(this._previousToken);
        if (this.last3Tokens.length > 3) {
            this.last3Tokens.shift();
        }
        if (this._previousToken.tokenType === 156 /* OpenTag */ || this._previousToken.tokenType === 157 /* OpenTagEcho */) {
            this.OpenTagCount++;
        }
        this._nextFormatRule = null;
        if (!this._active && this._startOffset > -1 && parsedDocument_1.ParsedDocument.isOffsetInToken(this._startOffset, node)) {
            this._active = true;
        }
        if (!previous) {
            return false;
        }
        switch (node.tokenType) {
            case 161 /* Whitespace */:
                this._nextFormatRule = rule;
                return false;
            case 159 /* Comment */:
                return false;
            case 160 /* DocumentComment */:
                rule = FormatVisitor.newlineIndentBefore;
                break;
            case 135 /* PlusPlus */:
                if (parent.phraseType === 132 /* PostfixIncrementExpression */) {
                    rule = FormatVisitor.noSpaceBefore;
                }
                break;
            case 129 /* MinusMinus */:
                if (parent.phraseType === 131 /* PostfixDecrementExpression */) {
                    rule = FormatVisitor.noSpaceBefore;
                }
                break;
            case 147 /* Backslash */:
                if (parent.phraseType === 121 /* NamespaceName */) {
                    rule = FormatVisitor.noSpaceBefore;
                }
                break;
            case 88 /* Semicolon */:
            case 93 /* Comma */:
            case 81 /* Text */:
            case 80 /* EncapsulatedAndWhitespace */:
            case 131 /* DollarCurlyOpen */:
            case 128 /* CurlyOpen */:
                rule = FormatVisitor.noSpaceBefore;
                break;
            case 116 /* OpenBrace */:
                if (previousNonWsToken && previousNonWsToken.tokenType === 90 /* Dollar */) {
                    rule = FormatVisitor.noSpaceBefore;
                }
                else if (!rule) {
                    rule = FormatVisitor.singleSpaceBefore;
                }
                break;
            case 87 /* Colon */:
                if (parent.phraseType === 17 /* CaseStatement */ || parent.phraseType === 48 /* DefaultStatement */) {
                    rule = FormatVisitor.noSpaceBefore;
                }
                break;
            case 156 /* OpenTag */:
            case 157 /* OpenTagEcho */:
                rule = FormatVisitor.noSpaceBefore;
                this._indentText = FormatVisitor.createWhitespace(Math.ceil((this.doc.lineSubstring(node.offset).length - 1) / this._indentUnit.length), this._indentUnit);
                break;
            case 18 /* Else */:
            case 19 /* ElseIf */:
                if (previousNonWsToken && previousNonWsToken.tokenType === 119 /* CloseBrace */) {
                    rule = FormatVisitor.singleSpaceBefore;
                }
                break;
            case 83 /* Name */:
                if (parent.phraseType === 136 /* PropertyAccessExpression */ || previousNonWsToken.tokenType === 147 /* Backslash */) {
                    rule = FormatVisitor.noSpaceBefore;
                }
                break;
            case 68 /* While */:
                if (parent.phraseType === 49 /* DoStatement */) {
                    rule = FormatVisitor.singleSpaceBefore;
                }
                break;
            case 8 /* Catch */:
                rule = FormatVisitor.singleSpaceBefore;
                break;
            case 115 /* Arrow */:
            case 133 /* ColonColon */:
                if (previous && previous.tokenType === 161 /* Whitespace */ && FormatVisitor.countNewlines(this.doc.tokenText(previous)) > 0) {
                    //get the outer member access expr
                    let outerExpr = parent;
                    for (let n = spine.length - 2; n >= 0; --n) {
                        if (parsedDocument_1.ParsedDocument.isPhrase(spine[n], FormatVisitor.memberAccessExprTypes)) {
                            outerExpr = spine[n];
                        }
                        else {
                            break;
                        }
                    }
                    if (!this._decrementOnTheseNodes.find((x) => { return x === outerExpr; })) {
                        this._decrementOnTheseNodes.push(outerExpr);
                        this._incrementIndent();
                    }
                }
                rule = FormatVisitor.noSpaceOrNewlineIndentBefore;
                break;
            case 118 /* OpenParenthesis */:
                if (this._shouldOpenParenthesisHaveNoSpaceBefore(parent, previousNonWsToken)) {
                    rule = FormatVisitor.noSpaceBefore;
                }
                else if (!rule) {
                    rule = FormatVisitor.singleSpaceBefore;
                }
                break;
            case 117 /* OpenBracket */:
                if (parent.phraseType === 160 /* SubscriptExpression */) {
                    rule = FormatVisitor.noSpaceBefore;
                }
                break;
            case 119 /* CloseBrace */:
                this._decrementIndent();
                if (parent.phraseType === 160 /* SubscriptExpression */ ||
                    parent.phraseType === 56 /* EncapsulatedExpression */ ||
                    parent.phraseType === 57 /* EncapsulatedVariable */) {
                    rule = FormatVisitor.noSpaceBefore;
                }
                else {
                    rule = FormatVisitor.newlineIndentBefore;
                }
                break;
            case 120 /* CloseBracket */:
            case 121 /* CloseParenthesis */:
                if (!rule) {
                    rule = FormatVisitor.noSpaceBefore;
                }
                break;
            case 158 /* CloseTag */:
                if (previous.tokenType === 159 /* Comment */ && this.doc.tokenText(previous).slice(0, 2) !== '/*') {
                    rule = FormatVisitor.noSpaceBefore;
                }
                else if (rule !== FormatVisitor.indentOrNewLineIndentBefore) {
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
        if (this._isKeyword(node)) {
            let text = this.doc.tokenText(node);
            let lcText = text.toLowerCase();
            if (text !== lcText) {
                this._edits.push(lsp.TextEdit.replace(this.doc.tokenRange(node), lcText));
            }
        }
        else if (this._isTrueFalseNull(node, spine)) {
            let text = this.doc.tokenText(node);
            let lcText = text.toLowerCase();
            if (text !== lcText) {
                this._edits.push(lsp.TextEdit.replace(this.doc.tokenRange(node), lcText));
            }
        }
        return false;
    }
    postorder(node, spine) {
        let parent = spine[spine.length - 1];
        let decrementOnNode = this._decrementOnTheseNodes.length ? this._decrementOnTheseNodes[this._decrementOnTheseNodes.length - 1] : undefined;
        if (decrementOnNode === node) {
            this._decrementIndent();
            this._decrementOnTheseNodes.pop();
        }
        switch (node.phraseType) {
            case 17 /* CaseStatement */:
            case 48 /* DefaultStatement */:
                this._decrementIndent();
                return;
            case 120 /* NamespaceDefinition */:
                this._nextFormatRule = FormatVisitor.doubleNewlineIndentBefore;
                return;
            case 124 /* NamespaceUseDeclaration */:
                if (this._isLastNamespaceUseDeclaration(parent, node)) {
                    this._nextFormatRule = FormatVisitor.doubleNewlineIndentBefore;
                }
                return;
            case 130 /* ParameterDeclarationList */:
            case 8 /* ArgumentExpressionList */:
            case 36 /* ClosureUseList */:
            case 142 /* QualifiedNameList */:
            case 11 /* ArrayInitialiserList */:
                if (this._isMultilineCommaDelimitedListStack.pop()) {
                    this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                    this._decrementIndent();
                    if (node.phraseType === 130 /* ParameterDeclarationList */) {
                        this._lastParameterListWasMultiLine = true;
                    }
                }
                return;
            case 44 /* ConstElementList */:
            case 139 /* PropertyElementList */:
            case 27 /* ClassConstElementList */:
            case 159 /* StaticVariableDeclarationList */:
            case 177 /* VariableNameList */:
                if (this._isMultilineCommaDelimitedListStack.pop()) {
                    this._decrementIndent();
                }
                return;
            case 58 /* EncapsulatedVariableList */:
                this._nextFormatRule = FormatVisitor.noSpaceBefore;
                return;
            case 4 /* AnonymousFunctionCreationExpression */:
                this._nextFormatRule = null;
                break;
            case undefined:
                //tokens
                break;
            default:
                return;
        }
        switch (node.tokenType) {
            case 159 /* Comment */:
                if (this.doc.tokenText(node).slice(0, 2) === '/*') {
                    this._nextFormatRule = FormatVisitor.singleSpaceOrNewlineIndentBefore;
                    if (this._active) {
                        let edit = this._formatDocBlock(node);
                        if (edit) {
                            this._edits.push(edit);
                        }
                    }
                }
                else {
                    this._nextFormatRule = FormatVisitor.indentOrNewLineIndentBefore;
                }
                break;
            case 160 /* DocumentComment */:
                this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                if (!this._active) {
                    break;
                }
                let edit = this._formatDocBlock(node);
                if (edit) {
                    this._edits.push(edit);
                }
                break;
            case 116 /* OpenBrace */:
                if (parent.phraseType === 56 /* EncapsulatedExpression */) {
                    this._nextFormatRule = FormatVisitor.noSpaceBefore;
                }
                else {
                    this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                }
                this._incrementIndent();
                break;
            case 119 /* CloseBrace */:
                if (parent.phraseType !== 57 /* EncapsulatedVariable */ &&
                    parent.phraseType !== 56 /* EncapsulatedExpression */ &&
                    parent.phraseType !== 160 /* SubscriptExpression */) {
                    this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                }
                break;
            case 88 /* Semicolon */:
                if (parent.phraseType === 83 /* ForStatement */) {
                    this._nextFormatRule = FormatVisitor.singleSpaceBefore;
                }
                else {
                    this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                }
                break;
            case 87 /* Colon */:
                if (this._shouldIndentAfterColon(spine[spine.length - 1])) {
                    this._incrementIndent();
                    this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                }
                break;
            case 103 /* Ampersand */:
                if (parent.phraseType !== 14 /* BitwiseExpression */) {
                    this._nextFormatRule = FormatVisitor.noSpaceBefore;
                }
                break;
            case 111 /* Plus */:
            case 143 /* Minus */:
                if (parent.phraseType === 174 /* UnaryOpExpression */) {
                    this._nextFormatRule = FormatVisitor.noSpaceBefore;
                }
                break;
            case 135 /* PlusPlus */:
                if (parent.phraseType === 134 /* PrefixIncrementExpression */) {
                    this._nextFormatRule = FormatVisitor.noSpaceBefore;
                }
                break;
            case 129 /* MinusMinus */:
                if (parent.phraseType === 133 /* PrefixDecrementExpression */) {
                    this._nextFormatRule = FormatVisitor.noSpaceBefore;
                }
                break;
            case 134 /* Ellipsis */:
            case 89 /* Exclamation */:
            case 94 /* AtSymbol */:
            case 155 /* ArrayCast */:
            case 148 /* BooleanCast */:
            case 153 /* FloatCast */:
            case 152 /* IntegerCast */:
            case 151 /* ObjectCast */:
            case 150 /* StringCast */:
            case 149 /* UnsetCast */:
            case 86 /* Tilde */:
            case 147 /* Backslash */:
            case 118 /* OpenParenthesis */:
            case 117 /* OpenBracket */:
                this._nextFormatRule = FormatVisitor.noSpaceBefore;
                break;
            case 128 /* CurlyOpen */:
            case 131 /* DollarCurlyOpen */:
                this._incrementIndent();
                this._nextFormatRule = FormatVisitor.noSpaceBefore;
                break;
            case 93 /* Comma */:
                if (parent.phraseType === 11 /* ArrayInitialiserList */ ||
                    parent.phraseType === 44 /* ConstElementList */ ||
                    parent.phraseType === 27 /* ClassConstElementList */ ||
                    parent.phraseType === 139 /* PropertyElementList */ ||
                    parent.phraseType === 159 /* StaticVariableDeclarationList */ ||
                    parent.phraseType === 177 /* VariableNameList */) {
                    this._nextFormatRule = FormatVisitor.singleSpaceOrNewlineIndentBefore;
                }
                else if (this._isMultilineCommaDelimitedListStack.length > 0 &&
                    this._isMultilineCommaDelimitedListStack[this._isMultilineCommaDelimitedListStack.length - 1]) {
                    this._nextFormatRule = FormatVisitor.newlineIndentBefore;
                }
                break;
            case 115 /* Arrow */:
            case 133 /* ColonColon */:
                this._nextFormatRule = FormatVisitor.noSpaceBefore;
                break;
            case 156 /* OpenTag */:
                let tagText = this.doc.tokenText(node);
                if (tagText.length > 2) {
                    if (FormatVisitor.countNewlines(tagText) > 0) {
                        this._nextFormatRule = FormatVisitor.indentOrNewLineIndentBefore;
                    }
                    else {
                        this._nextFormatRule = FormatVisitor.noSpaceOrNewlineIndentBefore;
                    }
                    break;
                }
            //fall through
            case 157 /* OpenTagEcho */:
                this._nextFormatRule = FormatVisitor.singleSpaceOrNewlineIndentBefore;
                break;
            default:
                break;
        }
        if (this._active && this._endOffset > -1 && parsedDocument_1.ParsedDocument.isOffsetInToken(this._endOffset, node)) {
            this.haltTraverse = true;
            this._active = false;
        }
    }
    _isTrueFalseNull(node, spine) {
        let parent = spine.length ? spine[spine.length - 1] : undefined;
        let greatGrandParent = spine.length > 2 ? spine[spine.length - 3] : undefined;
        const keywords = ['true', 'false', 'null'];
        return parsedDocument_1.ParsedDocument.isToken(node, [83 /* Name */]) &&
            parsedDocument_1.ParsedDocument.isPhrase(parent, [121 /* NamespaceName */]) &&
            parent.children.length === 1 &&
            parsedDocument_1.ParsedDocument.isPhrase(greatGrandParent, [41 /* ConstantAccessExpression */]) &&
            keywords.indexOf(this.doc.tokenText(node).toLowerCase()) > -1;
    }
    _formatDocBlock(node) {
        let text = this.doc.tokenText(node);
        let formatted = text.replace(FormatVisitor._docBlockRegex, '\n' + this._indentText + ' *');
        return formatted !== text ? lsp.TextEdit.replace(this.doc.tokenRange(node), formatted) : null;
    }
    _incrementIndent() {
        this._indentText += this._indentUnit;
    }
    _decrementIndent() {
        this._indentText = this._indentText.slice(0, -this._indentUnit.length);
    }
    _hasNewlineWhitespaceChild(phrase) {
        for (let n = 0, l = phrase.children.length; n < l; ++n) {
            if (phrase.children[n].tokenType === 161 /* Whitespace */ &&
                FormatVisitor.countNewlines(this.doc.tokenText(phrase.children[n])) > 0) {
                return true;
            }
        }
        return false;
    }
    _isLastNamespaceUseDeclaration(parent, child) {
        let i = parent.children.indexOf(child);
        while (i < parent.children.length) {
            ++i;
            child = parent.children[i];
            if (child.phraseType) {
                return child.phraseType !== 124 /* NamespaceUseDeclaration */;
            }
        }
        return true;
    }
    _shouldIndentAfterColon(parent) {
        switch (parent.phraseType) {
            case 17 /* CaseStatement */:
            case 48 /* DefaultStatement */:
                return true;
            default:
                return false;
        }
    }
    _shouldOpenParenthesisHaveNoSpaceBefore(parent, lastNonWsToken) {
        switch (parent.phraseType) {
            case 85 /* FunctionCallExpression */:
            case 112 /* MethodCallExpression */:
            case 150 /* ScopedCallExpression */:
            case 51 /* EchoIntrinsic */:
            case 55 /* EmptyIntrinsic */:
            case 69 /* EvalIntrinsic */:
            case 70 /* ExitIntrinsic */:
            case 107 /* IssetIntrinsic */:
            case 108 /* ListIntrinsic */:
            case 135 /* PrintIntrinsic */:
            case 175 /* UnsetIntrinsic */:
            case 9 /* ArrayCreationExpression */:
            case 88 /* FunctionDeclarationHeader */:
            case 115 /* MethodDeclarationHeader */:
            case 128 /* ObjectCreationExpression */:
            case 146 /* RequireExpression */:
            case 147 /* RequireOnceExpression */:
            case 97 /* IncludeExpression */:
            case 98 /* IncludeOnceExpression */:
                return true;
            default:
                if (!lastNonWsToken) {
                    return false;
                }
                break;
        }
        switch (lastNonWsToken.tokenType) {
            case 57 /* Require */:
            case 58 /* RequireOnce */:
            case 41 /* Include */:
            case 42 /* IncludeOnce */:
            case 46 /* Isset */:
            case 47 /* List */:
            case 53 /* Print */:
            case 65 /* Unset */:
            case 28 /* Eval */:
            case 29 /* Exit */:
            case 20 /* Empty */:
                return true;
            default:
                return false;
        }
    }
    _hasColonChild(phrase) {
        for (let n = 0, l = phrase.children.length; n < l; ++n) {
            if (phrase.children[n].tokenType === 87 /* Colon */) {
                return true;
            }
        }
        return false;
    }
    _isKeyword(t) {
        if (!t) {
            return false;
        }
        switch (t.tokenType) {
            case 2 /* Abstract */:
            case 3 /* Array */:
            case 4 /* As */:
            case 5 /* Break */:
            case 6 /* Callable */:
            case 7 /* Case */:
            case 8 /* Catch */:
            case 9 /* Class */:
            case 10 /* ClassConstant */:
            case 11 /* Clone */:
            case 12 /* Const */:
            case 13 /* Continue */:
            case 14 /* Declare */:
            case 15 /* Default */:
            case 16 /* Do */:
            case 17 /* Echo */:
            case 18 /* Else */:
            case 19 /* ElseIf */:
            case 20 /* Empty */:
            case 21 /* EndDeclare */:
            case 22 /* EndFor */:
            case 23 /* EndForeach */:
            case 24 /* EndIf */:
            case 25 /* EndSwitch */:
            case 26 /* EndWhile */:
            case 28 /* Eval */:
            case 29 /* Exit */:
            case 30 /* Extends */:
            case 31 /* Final */:
            case 32 /* Finally */:
            case 33 /* For */:
            case 34 /* ForEach */:
            case 35 /* Function */:
            case 36 /* Global */:
            case 37 /* Goto */:
            case 38 /* HaltCompiler */:
            case 39 /* If */:
            case 40 /* Implements */:
            case 41 /* Include */:
            case 42 /* IncludeOnce */:
            case 43 /* InstanceOf */:
            case 44 /* InsteadOf */:
            case 45 /* Interface */:
            case 46 /* Isset */:
            case 47 /* List */:
            case 48 /* And */:
            case 49 /* Or */:
            case 50 /* Xor */:
            case 51 /* Namespace */:
            case 52 /* New */:
            case 53 /* Print */:
            case 54 /* Private */:
            case 55 /* Public */:
            case 56 /* Protected */:
            case 57 /* Require */:
            case 58 /* RequireOnce */:
            case 59 /* Return */:
            case 60 /* Static */:
            case 61 /* Switch */:
            case 62 /* Throw */:
            case 63 /* Trait */:
            case 64 /* Try */:
            case 65 /* Unset */:
            case 66 /* Use */:
            case 67 /* Var */:
            case 68 /* While */:
            case 69 /* Yield */:
            case 70 /* YieldFrom */:
                return true;
            default:
                return false;
        }
    }
}
FormatVisitor._docBlockRegex = /(?:\r\n|\r|\n)[ \t]*\*/g;
FormatVisitor.memberAccessExprTypes = [
    112 /* MethodCallExpression */, 136 /* PropertyAccessExpression */,
    150 /* ScopedCallExpression */, 24 /* ClassConstantAccessExpression */, 152 /* ScopedPropertyAccessExpression */
];
(function (FormatVisitor) {
    function singleSpaceBefore(previous, doc, indentText, indentUnit) {
        if (previous.tokenType !== 161 /* Whitespace */) {
            return lsp.TextEdit.insert(doc.positionAtOffset(previous.offset + previous.length), ' ');
        }
        let actualWs = doc.tokenText(previous);
        let expectedWs = ' ';
        if (actualWs === expectedWs) {
            return null;
        }
        return lsp.TextEdit.replace(doc.tokenRange(previous), expectedWs);
    }
    FormatVisitor.singleSpaceBefore = singleSpaceBefore;
    function indentBefore(previous, doc, indentText, indentUnit) {
        if (previous.tokenType !== 161 /* Whitespace */) {
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
    FormatVisitor.indentBefore = indentBefore;
    function indentOrNewLineIndentBefore(previous, doc, indentText, indentUnit) {
        if (previous.tokenType !== 161 /* Whitespace */) {
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
    FormatVisitor.indentOrNewLineIndentBefore = indentOrNewLineIndentBefore;
    function newlineIndentBefore(previous, doc, indentText, indentUnit) {
        if (previous.tokenType !== 161 /* Whitespace */) {
            return lsp.TextEdit.insert(doc.positionAtOffset(previous.offset + previous.length), '\n' + indentText);
        }
        let actualWs = doc.tokenText(previous);
        let expectedWs = createWhitespace(Math.max(1, countNewlines(actualWs)), '\n') + indentText;
        if (actualWs === expectedWs) {
            return null;
        }
        return lsp.TextEdit.replace(doc.tokenRange(previous), expectedWs);
    }
    FormatVisitor.newlineIndentBefore = newlineIndentBefore;
    function doubleNewlineIndentBefore(previous, doc, indentText, indentUnit) {
        if (previous.tokenType !== 161 /* Whitespace */) {
            return lsp.TextEdit.insert(doc.positionAtOffset(previous.offset + previous.length), '\n\n' + indentText);
        }
        let actualWs = doc.tokenText(previous);
        let expected = createWhitespace(Math.max(2, countNewlines(actualWs)), '\n') + indentText;
        if (actualWs === expected) {
            return null;
        }
        return lsp.TextEdit.replace(doc.tokenRange(previous), expected);
    }
    FormatVisitor.doubleNewlineIndentBefore = doubleNewlineIndentBefore;
    function noSpaceBefore(previous, doc, indentText, indentUnit) {
        if (previous.tokenType !== 161 /* Whitespace */) {
            return null;
        }
        return lsp.TextEdit.del(doc.tokenRange(previous));
    }
    FormatVisitor.noSpaceBefore = noSpaceBefore;
    function noSpaceOrNewlineIndentPlusOneBefore(previous, doc, indentText, indentUnit) {
        if (previous.tokenType !== 161 /* Whitespace */) {
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
    FormatVisitor.noSpaceOrNewlineIndentPlusOneBefore = noSpaceOrNewlineIndentPlusOneBefore;
    function noSpaceOrNewlineIndentBefore(previous, doc, indentText, indentUnit) {
        if (previous.tokenType !== 161 /* Whitespace */) {
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
    FormatVisitor.noSpaceOrNewlineIndentBefore = noSpaceOrNewlineIndentBefore;
    function singleSpaceOrNewlineIndentPlusOneBefore(previous, doc, indentText, indentUnit) {
        if (previous.tokenType !== 161 /* Whitespace */) {
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
    FormatVisitor.singleSpaceOrNewlineIndentPlusOneBefore = singleSpaceOrNewlineIndentPlusOneBefore;
    function singleSpaceOrNewlineIndentBefore(previous, doc, indentText, indentUnit) {
        if (previous.tokenType !== 161 /* Whitespace */) {
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
    FormatVisitor.singleSpaceOrNewlineIndentBefore = singleSpaceOrNewlineIndentBefore;
    function createWhitespace(n, unit) {
        let text = '';
        while (n > 0) {
            text += unit;
            --n;
        }
        return text;
    }
    FormatVisitor.createWhitespace = createWhitespace;
    function countNewlines(text) {
        let c;
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
            }
            else if (c === '\n') {
                ++count;
            }
        }
        return count;
    }
    FormatVisitor.countNewlines = countNewlines;
})(FormatVisitor || (FormatVisitor = {}));
