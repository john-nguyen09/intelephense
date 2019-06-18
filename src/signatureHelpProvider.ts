/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import * as lsp from 'vscode-languageserver-types';
import { SymbolKind, PhpSymbol, SymbolModifier } from './symbol';
import { SymbolStore } from './symbolStore';
import { ParseTreeTraverser } from './parseTreeTraverser';
import { TypeString } from './typeString';
import { ParsedDocument, ParsedDocumentStore } from './parsedDocument';
import { Phrase, PhraseType, Token, TokenType } from 'php7parser';
import * as util from './util';
import { MemberMergeStrategy } from './typeAggregate';
import {ReferenceStore} from './reference';


export class SignatureHelpProvider {

    constructor(public symbolStore: SymbolStore, public docStore: ParsedDocumentStore, public refStore:ReferenceStore) { }

    async provideSignatureHelp(uri: string, position: lsp.Position) {
        let response: lsp.SignatureHelp | null = null;
        
        await this.docStore.acquireLock(uri, async() => {
            let doc = this.docStore.find(uri);
            let table = await this.symbolStore.getSymbolTable(uri);
            let refTable = this.refStore.getReferenceTable(uri);
            if (!doc || !table || !refTable) {
                return;
            }
    
            let traverser = new ParseTreeTraverser(doc, table, refTable);
            let token = traverser.position(position);
            let callableExpr = traverser.ancestor(this._isCallablePhrase) as Phrase;
            if (!callableExpr || !token || token.tokenType === TokenType.CloseParenthesis) {
                return;
            }
    
            let symbol = await this._getSymbol(traverser.clone());
            let delimFilterFn = (x:Phrase|Token) => {
                return (<Token>x).tokenType === TokenType.Comma && (<Token>x).offset <= token.offset;
            };
            let argNumber = ParsedDocument.filterChildren(<Phrase>ParsedDocument.findChild(callableExpr, this._isArgExprList), delimFilterFn).length;
    
            if (symbol) {
                response = this._createSignatureHelp(symbol, argNumber);
            }
        });

        return response;
    }

    private _createSignatureHelp(fn: PhpSymbol, argNumber: number) {

        if (!fn.children) {
            return null;
        }

        let params = fn.children.filter((x) => {
            return x.kind === SymbolKind.Parameter;
        });

        if (!params.length || argNumber > params.length - 1) {
            return null;
        }

        let nOptionalParams = params.reduce<number>((carry, value) => {
            return value.value ? carry + 1 : carry;
        }, 0);

        let nRequiredParams = params.length - nOptionalParams;
        let signatures: lsp.SignatureInformation[] = [];

        signatures.push(this._signatureInfo(fn, params));

        return <lsp.SignatureHelp>{
            activeParameter: argNumber,
            activeSignature: 0,
            signatures: signatures
        };
    }

    private _signatureInfo(fn: PhpSymbol, params: PhpSymbol[]) {

        let paramInfoArray = this._parameterInfoArray(params);
        let label = fn.name + '(';
        label += paramInfoArray.map((v) => {
            return v.label;
        }).join(', ');
        label += ')';

        let returnType = PhpSymbol.type(fn);
        if (returnType) {
            label += ': ' + returnType;
        }

        let info = <lsp.SignatureInformation>{
            label: label,
            parameters: paramInfoArray
        }

        if (fn.doc && fn.doc.description) {
            info.documentation = fn.doc.description;
        }

        return info;

    }

    private _parameterInfoArray(params: PhpSymbol[]) {

        let infos: lsp.ParameterInformation[] = [];
        for (let n = 0, l = params.length; n < l; ++n) {
            infos.push(this._parameterInfo(params[n]));
        }

        return infos;
    }

    private _parameterInfo(s: PhpSymbol) {

        let labelParts: string[] = [];
        let paramType = PhpSymbol.type(s);
        if (paramType) {
            labelParts.push(paramType);
        }

        labelParts.push(s.name);

        if (s.value) {
            labelParts.push('= ' + s.value);
        }

        let info = <lsp.ParameterInformation>{
            label: labelParts.join(' '),
        };

        if (s.doc && s.doc.description) {
            info.documentation = s.doc.description;
        }

        return info;
    }

    private async _getSymbol(traverser:ParseTreeTraverser) {
        let expr = traverser.node as Phrase;
        switch (expr.phraseType) {
            case PhraseType.FunctionCallExpression:
                if(traverser.child(this._isNamePhrase)){
                    return (await this.symbolStore.findSymbolsByReference(traverser.reference))
                        .shift();
                }
                return undefined;
            case PhraseType.MethodCallExpression:
                if(traverser.child(this._isMemberName) && traverser.child(this._isNameToken)) {
                    return (await this.symbolStore.findSymbolsByReference(traverser.reference, MemberMergeStrategy.Documented))
                        .shift();
                }
                return undefined;
            case PhraseType.ScopedCallExpression:
                if(traverser.child(this._isScopedMemberName) && traverser.child(this._isIdentifier)) {
                    return (await this.symbolStore.findSymbolsByReference(traverser.reference, MemberMergeStrategy.Documented))
                        .shift();
                }
                return undefined;
            case PhraseType.ObjectCreationExpression:
                if(traverser.child(this._isClassTypeDesignator) && traverser.child(this._isNamePhraseOrRelativeScope)) {
                    return (await this.symbolStore.findSymbolsByReference(traverser.reference, MemberMergeStrategy.Override))
                        .shift();
                }
                return undefined;
                
            default:
                throw new Error('Invalid Argument');
        }
    }

    private _isCallablePhrase(node: Phrase | Token) {
        switch ((<Phrase>node).phraseType) {
            case PhraseType.FunctionCallExpression:
            case PhraseType.MethodCallExpression:
            case PhraseType.ScopedCallExpression:
            case PhraseType.ObjectCreationExpression:
                return true;
            default:
                return false;
        }
    }

    private _isNamePhrase(node:Phrase|Token) {
        switch((<Phrase>node).phraseType) {
            case PhraseType.FullyQualifiedName:
            case PhraseType.RelativeQualifiedName:
            case PhraseType.QualifiedName:
                return true;
            default:
                return false;
        }
    }

    private _isArgExprList(node:Phrase|Token) {
        return (<Phrase>node).phraseType === PhraseType.ArgumentExpressionList;
    }

    private _isMemberName(node:Phrase|Token) {
        return (<Phrase>node).phraseType === PhraseType.MemberName;
    }

    private _isScopedMemberName(node:Phrase|Token) {
        return (<Phrase>node).phraseType === PhraseType.ScopedMemberName;
    }

    private _isNameToken(node:Phrase|Token) {
        return (<Token>node).tokenType === TokenType.Name;
    }

    private _isIdentifier(node:Phrase|Token) {
        return (<Phrase>node).phraseType === PhraseType.Identifier;
    }

    private _isClassTypeDesignator(node:Phrase|Token) {
        return (<Phrase>node).phraseType === PhraseType.ClassTypeDesignator;
    }

    private _isNamePhraseOrRelativeScope(node:Phrase|Token) {
        switch((<Phrase>node).phraseType) {
            case PhraseType.FullyQualifiedName:
            case PhraseType.RelativeQualifiedName:
            case PhraseType.QualifiedName:
            case PhraseType.RelativeScope:
                return true;
            default:
                return false;
        }
    }

}