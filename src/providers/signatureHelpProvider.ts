/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import * as lsp from 'vscode-languageserver-types';
import { SymbolKind, PhpSymbol, SymbolModifier } from '../symbol';
import { SymbolStore } from '../symbolStore';
import { ParseTreeTraverser } from '../parseTreeTraverser';
import { ParsedDocument, ParsedDocumentStore } from '../parsedDocument';
import { MemberMergeStrategy } from '../typeAggregate';
import { ReferenceStore } from '../reference';
import { SyntaxNode } from 'tree-sitter';


export class SignatureHelpProvider {

    constructor(public symbolStore: SymbolStore, public docStore: ParsedDocumentStore, public refStore: ReferenceStore) { }

    async provideSignatureHelp(uri: string, position: lsp.Position): Promise<lsp.SignatureHelp | null> {
        let response: lsp.SignatureHelp | null = null;

        await this.docStore.acquireLock(uri, async () => {
            const doc = this.docStore.find(uri);
            const table = await this.symbolStore.getSymbolTable(uri);
            const refTable = this.refStore.getReferenceTable(uri);
            if (!doc || !table || !refTable) {
                return;
            }

            const traverser = new ParseTreeTraverser(doc, table, refTable);
            const token = traverser.position(position);
            const callableExpr = traverser.ancestor(this._isCallablePhrase);
            if (!callableExpr || !token || token.type === ')') {
                return;
            }

            const symbol = await this._getSymbol(traverser.clone());
            const delimFilterFn = (x: SyntaxNode) => {
                return x.type === ',' && x.startIndex <= token.startIndex;
            };
            const argNumber = ParsedDocument.filterChildren(ParsedDocument.findChild(callableExpr, this._isArgExprList), delimFilterFn).length;

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

    private async _getSymbol(traverser: ParseTreeTraverser) {
        const expr = traverser.node;

        if (expr === null) {
            return undefined;
        }

        switch (expr.type) {
            case 'function_call_expression':
                if (traverser.child(this._isNamePhrase)) {
                    return (await this.symbolStore.findSymbolsByReference(traverser.reference))
                        .shift();
                }
                return undefined;
            case 'member_call_expression':
                if (traverser.child(this._isMemberName) && traverser.child(this._isNameToken)) {
                    return (await this.symbolStore.findSymbolsByReference(traverser.reference, MemberMergeStrategy.Documented))
                        .shift();
                }
                return undefined;
            case 'scoped_call_expression':
                if (traverser.child(this._isScopedMemberName) && traverser.child(this._isIdentifier)) {
                    return (await this.symbolStore.findSymbolsByReference(traverser.reference, MemberMergeStrategy.Documented))
                        .shift();
                }
                return undefined;
            case 'object_creation_expression':
                if (traverser.child(this._isClassTypeDesignator) && traverser.child(this._isNameOrRelativeScope)) {
                    return (await this.symbolStore.findSymbolsByReference(traverser.reference, MemberMergeStrategy.Override))
                        .shift();
                }
                return undefined;

            default:
                throw new Error('Invalid Argument');
        }
    }

    private _isCallablePhrase(node: SyntaxNode) {
        return [
            'function_call_expression',
            'member_call_expression',
            'scoped_call_expression',
            'object_creation_expression',
        ].includes(node.type);
    }

    private _isNamePhrase(node: SyntaxNode) {
        return [
            'qualified_name',
        ].includes(node.type);
    }

    private _isArgExprList(node: SyntaxNode) {
        return node.type === 'arguments';
    }

    private _isMemberName(node: SyntaxNode) {
        return node.type === 'member_name';
    }

    private _isScopedMemberName(node: SyntaxNode) {
        return node.type === 'member_name';
    }

    private _isNameToken(node: SyntaxNode) {
        return node.type === 'name';
    }

    private _isIdentifier(node: SyntaxNode) {
        return node.type === 'name';
    }

    private _isClassTypeDesignator(node: SyntaxNode) {
        return [
            'qualified_name',
            'new_variable',
        ].includes(node.type);
    }

    private _isNameOrRelativeScope(node: SyntaxNode) {
        return [
            'name',
            'relative_scope',
        ].includes(node.type);
    }

}