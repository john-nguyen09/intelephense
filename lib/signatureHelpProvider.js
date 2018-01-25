/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const symbol_1 = require("./symbol");
const parseTreeTraverser_1 = require("./parseTreeTraverser");
const parsedDocument_1 = require("./parsedDocument");
class SignatureHelpProvider {
    constructor(symbolStore, docStore, refStore) {
        this.symbolStore = symbolStore;
        this.docStore = docStore;
        this.refStore = refStore;
    }
    provideSignatureHelp(uri, position) {
        let doc = this.docStore.find(uri);
        let table = this.symbolStore.getSymbolTable(uri);
        let refTable = this.refStore.getReferenceTable(uri);
        if (!doc || !table || !refTable) {
            return null;
        }
        let traverser = new parseTreeTraverser_1.ParseTreeTraverser(doc, table, refTable);
        let token = traverser.position(position);
        let callableExpr = traverser.ancestor(this._isCallablePhrase);
        if (!callableExpr || !token || token.tokenType === 121 /* CloseParenthesis */) {
            return null;
        }
        let symbol = this._getSymbol(traverser.clone());
        let delimFilterFn = (x) => {
            return x.tokenType === 93 /* Comma */ && x.offset <= token.offset;
        };
        let argNumber = parsedDocument_1.ParsedDocument.filterChildren(parsedDocument_1.ParsedDocument.findChild(callableExpr, this._isArgExprList), delimFilterFn).length;
        return symbol ? this._createSignatureHelp(symbol, argNumber) : null;
    }
    _createSignatureHelp(fn, argNumber) {
        if (!fn.children) {
            return null;
        }
        let params = fn.children.filter((x) => {
            return x.kind === 128 /* Parameter */;
        });
        if (!params.length || argNumber > params.length - 1) {
            return null;
        }
        let nOptionalParams = params.reduce((carry, value) => {
            return value.value ? carry + 1 : carry;
        }, 0);
        let nRequiredParams = params.length - nOptionalParams;
        let signatures = [];
        if (nRequiredParams > 0) {
            signatures.push(this._signatureInfo(fn, params.slice(0, nRequiredParams)));
        }
        for (let n = 1; n <= nOptionalParams; ++n) {
            signatures.push(this._signatureInfo(fn, params.slice(0, nRequiredParams + n)));
        }
        let activeSig = signatures.findIndex((v) => {
            return v.parameters.length > argNumber;
        });
        return {
            activeParameter: argNumber,
            activeSignature: activeSig,
            signatures: signatures
        };
    }
    _signatureInfo(fn, params) {
        let paramInfoArray = this._parameterInfoArray(params);
        let label = fn.name + '(';
        label += paramInfoArray.map((v) => {
            return v.label;
        }).join(', ');
        label += ')';
        let returnType = symbol_1.PhpSymbol.type(fn);
        if (returnType) {
            label += ': ' + returnType;
        }
        let info = {
            label: label,
            parameters: paramInfoArray
        };
        if (fn.doc && fn.doc.description) {
            info.documentation = fn.doc.description;
        }
        return info;
    }
    _parameterInfoArray(params) {
        let infos = [];
        for (let n = 0, l = params.length; n < l; ++n) {
            infos.push(this._parameterInfo(params[n]));
        }
        return infos;
    }
    _parameterInfo(s) {
        let labelParts = [];
        let paramType = symbol_1.PhpSymbol.type(s);
        if (paramType) {
            labelParts.push(paramType);
        }
        labelParts.push(s.name);
        if (s.value) {
            labelParts.push('= ' + s.value);
        }
        let info = {
            label: labelParts.join(' '),
        };
        if (s.doc && s.doc.description) {
            info.documentation = s.doc.description;
        }
        return info;
    }
    _getSymbol(traverser) {
        let expr = traverser.node;
        switch (expr.phraseType) {
            case 85 /* FunctionCallExpression */:
                if (traverser.child(this._isNamePhrase)) {
                    return this.symbolStore.findSymbolsByReference(traverser.reference).shift();
                }
                return undefined;
            case 112 /* MethodCallExpression */:
                if (traverser.child(this._isMemberName) && traverser.child(this._isNameToken)) {
                    return this.symbolStore.findSymbolsByReference(traverser.reference, 2 /* Documented */).shift();
                }
                return undefined;
            case 150 /* ScopedCallExpression */:
                if (traverser.child(this._isScopedMemberName) && traverser.child(this._isIdentifier)) {
                    return this.symbolStore.findSymbolsByReference(traverser.reference, 2 /* Documented */).shift();
                }
                return undefined;
            case 128 /* ObjectCreationExpression */:
                if (traverser.child(this._isClassTypeDesignator) && traverser.child(this._isNamePhraseOrRelativeScope)) {
                    return this.symbolStore.findSymbolsByReference(traverser.reference, 1 /* Override */).shift();
                }
                return undefined;
            default:
                throw new Error('Invalid Argument');
        }
    }
    _isCallablePhrase(node) {
        switch (node.phraseType) {
            case 85 /* FunctionCallExpression */:
            case 112 /* MethodCallExpression */:
            case 150 /* ScopedCallExpression */:
            case 128 /* ObjectCreationExpression */:
                return true;
            default:
                return false;
        }
    }
    _isNamePhrase(node) {
        switch (node.phraseType) {
            case 84 /* FullyQualifiedName */:
            case 144 /* RelativeQualifiedName */:
            case 141 /* QualifiedName */:
                return true;
            default:
                return false;
        }
    }
    _isArgExprList(node) {
        return node.phraseType === 8 /* ArgumentExpressionList */;
    }
    _isMemberName(node) {
        return node.phraseType === 111 /* MemberName */;
    }
    _isScopedMemberName(node) {
        return node.phraseType === 151 /* ScopedMemberName */;
    }
    _isNameToken(node) {
        return node.tokenType === 83 /* Name */;
    }
    _isIdentifier(node) {
        return node.phraseType === 95 /* Identifier */;
    }
    _isClassTypeDesignator(node) {
        return node.phraseType === 34 /* ClassTypeDesignator */;
    }
    _isNamePhraseOrRelativeScope(node) {
        switch (node.phraseType) {
            case 84 /* FullyQualifiedName */:
            case 144 /* RelativeQualifiedName */:
            case 141 /* QualifiedName */:
            case 145 /* RelativeScope */:
                return true;
            default:
                return false;
        }
    }
}
exports.SignatureHelpProvider = SignatureHelpProvider;
