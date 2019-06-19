/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import { Position, ReferenceContext, Location } from 'vscode-languageserver-types';
import { ParsedDocumentStore, ParsedDocument } from '../parsedDocument';
import { ParseTreeTraverser } from '../parseTreeTraverser';
import { SymbolStore, SymbolTable } from '../symbolStore';
import { PhpSymbol, SymbolKind, SymbolModifier, SymbolIdentifier } from '../symbol';
import { MemberMergeStrategy, TypeAggregate } from '../typeAggregate';
import { Reference, ReferenceStore, ReferenceTable, Scope } from '../reference';
import { Predicate, TreeVisitor, TreeTraverser, AsyncPredicate } from '../types';
import * as util from '../util';
import { TypeString } from '../typeString';



function _sameNameAndScope(
    name: string, scope: string | Promise<string>
): AsyncPredicate<Reference | Scope> {
    return async (ref: Reference): Promise<boolean> => {
        return ref.name.toLowerCase() === name &&
            (ref.scope && (await TypeString.resolve(ref.scope)).toLowerCase() === scope);
    };
}

export class ReferenceProvider {

    constructor(public documentStore: ParsedDocumentStore, public symbolStore: SymbolStore, public refStore: ReferenceStore) {

    }

    async provideReferenceLocations(uri: string, position: Position, referenceContext: ReferenceContext) {

        let locations: Location[] = [];
        let doc = this.documentStore.find(uri);
        let table = this.refStore.getReferenceTable(uri);

        if (!doc || !table) {
            return Promise.resolve(locations);
        }

        let symbols: PhpSymbol[];
        let ref = table.referenceAtPosition(position);
        if (ref) {
            //get symbol definition
            //for constructors get the class instead of __construct
            if (ref.kind === SymbolKind.Constructor) {
                ref = { kind: SymbolKind.Class, name: ref.name, location: ref.location };
            }

            //if class member then make sure base symbol is fetched
            symbols = await this.symbolStore.findSymbolsByReference(ref, MemberMergeStrategy.Base);
        } else {
            return locations;
        }

        return this.provideReferences(symbols, table, referenceContext.includeDeclaration).then((refs) => {
            return refs.map((v) => {
                return v.location;
            })
        });

    }

    /**
     * 
     * @param symbols must be base symbols where kind is method, class const or prop
     * @param table 
     * @param includeDeclaration 
     */
    provideReferences(symbols: PhpSymbol[], table: ReferenceTable, includeDeclaration: boolean): Promise<Reference[]> {

        let refs: Reference[] = [];
        let provideRefsFn = this._provideReferences;

        return new Promise<Reference[]>((resolve, reject) => {

            let onResolve = (r:Reference[]) => {
                Array.prototype.push.apply(refs, r);
                let s = symbols.pop();
                if(s) {
                    provideRefsFn(s, table).then(onResolve);
                } else {
                    resolve(Array.from(new Set<Reference>(refs)));
                }
            }

            onResolve([]);

        });

    }

    private _provideReferences = async (symbol: PhpSymbol, table: ReferenceTable): Promise<Reference[]> => {
        switch (symbol.kind) {
            case SymbolKind.Parameter:
            case SymbolKind.Variable:
                return this._variableReferences(
                    symbol, table, await this.symbolStore.getSymbolTable(table.uri)
                );
            case SymbolKind.Class:
            case SymbolKind.Interface:
            case SymbolKind.Trait:
            case SymbolKind.Function:
            case SymbolKind.Constant:
                return await this.refStore.find(symbol.name);
            case SymbolKind.Property:
                return await this._propertyReferences(symbol, table);
            case SymbolKind.ClassConstant:
                return await this._classConstantReferences(symbol, table);
            case SymbolKind.Method:
                return await this._methodReferences(symbol, table);
            default:
                return [];
        }

    }

    private async _methodReferences(symbol: PhpSymbol, table: ReferenceTable) {

        if ((symbol.modifiers & SymbolModifier.Private) > 0) {
            let lcScope = symbol.scope ? symbol.scope.toLowerCase() : '';
            let name = symbol.name.toLowerCase();
            let fn = (x: Reference) => {
                return x.kind === SymbolKind.Method;
            };
            return this._symbolRefsInTableScope(symbol, table, fn, _sameNameAndScope(name, lcScope));
        } else {
            const results = await this.refStore.find(symbol.name);
            const refs: Reference[] = [];
            const predicate = this._createMemberReferenceFilterFn(symbol);

            for (const ref of results) {
                if (await predicate(ref)) {
                    refs.push(ref);
                }
            }

            return refs;
        }
    }

    private async _classConstantReferences(symbol: PhpSymbol, table: ReferenceTable) {

        if ((symbol.modifiers & SymbolModifier.Private) > 0) {
            let lcScope = symbol.scope ? symbol.scope.toLowerCase() : '';
            let name = symbol.name.toLowerCase();
            let fn = (x: Reference) => {
                return x.kind === SymbolKind.ClassConstant;
            };
            return this._symbolRefsInTableScope(symbol, table, fn, _sameNameAndScope(name, lcScope));
        } else {
            const results = await this.refStore.find(symbol.name);
            const refs: Reference[] = [];
            const predicate = this._createMemberReferenceFilterFn(symbol);

            for (const ref of results) {
                if (await predicate(ref)) {
                    refs.push(ref);
                }
            }

            return refs;
        }
    }

    private async _propertyReferences(symbol: PhpSymbol, table: ReferenceTable) {

        let name = symbol.name;
        if ((symbol.modifiers & SymbolModifier.Private) > 0) {
            let lcScope = symbol.scope ? symbol.scope.toLowerCase() : '';
            let fn = (x: Reference) => {
                return x.kind === SymbolKind.Property;
            };
            return this._symbolRefsInTableScope(symbol, table, fn, _sameNameAndScope(name, lcScope));
        } else {
            const results = await this.refStore.find(name);
            const refs: Reference[] = [];
            const predicate = this._createMemberReferenceFilterFn(symbol);

            for (const ref of results) {
                if (await predicate(ref)) {
                    refs.push(ref);
                }
            }

            return refs;
        }

    }

    private _createMemberReferenceFilterFn(baseMember: PhpSymbol) {

        let store = this.symbolStore;
        let lcBaseTypeName = baseMember.scope ? baseMember.scope.toLowerCase() : '';
        let map: { [index: string]: boolean } = {};
        map[lcBaseTypeName] = true;
        let associatedFilterFn = (x: PhpSymbol) => {
            return lcBaseTypeName === x.name.toLowerCase();
        };

        return async (r: Reference) => {

            if (!(r.kind & (SymbolKind.Property | SymbolKind.Method | SymbolKind.ClassConstant)) || !r.scope) {
                return false;
            }
            const scope = await TypeString.resolve(r.scope);

            let lcScope = scope.toLowerCase();
            if (map[lcScope] !== undefined) {
                return map[lcScope];
            }

            let aggregateType = await TypeAggregate.create(store, scope);
            if (!aggregateType) {
                return map[lcScope] = false;
            }
            return map[lcScope] = (await aggregateType.associated(associatedFilterFn)).length > 0;

        };

    }

    private _variableReferences(symbol: PhpSymbol, refTable: ReferenceTable, symbolTable:SymbolTable) {

        let symbolTreeTraverser = symbolTable.createTraverser();
        symbolTreeTraverser.find((x)=>{
            return PhpSymbol.equality(x, symbol);
        });

        let outerScope = symbolTreeTraverser.parent();
        let useVarFn = (s: PhpSymbol) => {
            return s.kind === SymbolKind.Variable &&
                (s.modifiers & SymbolModifier.Use) > 0 &&
                s.name === symbol.name;
        };

        let isScopeSymbol:Predicate<PhpSymbol> = (x) => {
            return x.kind === SymbolKind.Function && (x.modifiers & SymbolModifier.Anonymous) > 0 && util.find(x.children, useVarFn) !== undefined;
        }

        while(outerScope && isScopeSymbol(outerScope)) {
            outerScope = symbolTreeTraverser.parent();
        }

        if(!outerScope) {
            return [];
        }
        
        //collect all scope positions to look for refs
        let scopePositions:Position[] = [];
        let varScopeVisitor:TreeVisitor<PhpSymbol> = {
            preorder:(node:PhpSymbol, spine:PhpSymbol[]) => {
                if(node === outerScope || isScopeSymbol(node)) {
                    if(node.location) {
                        scopePositions.push(node.location.range.start);
                    }
                    return true;
                }
                return false;
            }
        }

        symbolTreeTraverser.traverse(varScopeVisitor);
        if(!scopePositions.length) {
            return [];
        }
        
        let refTreeTraverser = refTable.createTraverser();
        let refs:Reference[] = [];
        let refFn = (r: Reference) => {
            return (r.kind === SymbolKind.Variable || r.kind === SymbolKind.Parameter) && r.name === symbol.name;
        };
        let isScope:Predicate<Scope|Reference> = (x:Scope|Reference) => {
            return (<Reference>x).kind === undefined && x.location && scopePositions.length && util.positionEquality(x.location.range.start, scopePositions[0])
        }
        if(!refTreeTraverser.find(isScope)) {
            return [];
        }
        
        let refVisitor:TreeVisitor<Scope|Reference> = {

            preorder:(node:Scope|Reference, spine:(Scope|Reference)[]) => {

                if(isScope(node)) {
                    scopePositions.shift();
                    return true;
                } else if(refFn(<Reference>node)) {
                    refs.push(<Reference>node);
                }
                return false;
            }
        }

        refTreeTraverser.traverse(refVisitor);
        return refs;

    }

    private async _symbolRefsInTableScope(
        symbol: PhpSymbol,
        refTable: ReferenceTable,
        filterFn: Predicate<Scope | Reference>,
        extraFilterFn: AsyncPredicate<Scope | Reference>
    ): Promise<Reference[]> {

        let traverser = refTable.createTraverser();
        let pos = symbol.location ? symbol.location.range.start : undefined;
        if (!pos) {
            return [];
        }

        let findFn = (x: Scope | Reference) => {
            return (<Reference>x).kind === undefined &&
                x.location && x.location.range && util.positionEquality(x.location.range.start, pos);
        }
        if (traverser.find(findFn) && traverser.parent()) {
            const results = traverser.filter(filterFn) as Reference[];
            const refs: Reference[] = [];

            for (const ref of results) {
                if (await extraFilterFn(ref)) {
                    refs.push(ref);
                }
            }

            return refs;
        }

        return [];
    }

}