/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const typeAggregate_1 = require("./typeAggregate");
const util = require("./util");
class ReferenceProvider {
    constructor(documentStore, symbolStore, refStore) {
        this.documentStore = documentStore;
        this.symbolStore = symbolStore;
        this.refStore = refStore;
        this._provideReferences = (symbol, table) => {
            switch (symbol.kind) {
                case 128 /* Parameter */:
                case 256 /* Variable */:
                    return Promise.resolve(this._variableReferences(symbol, table, this.symbolStore.getSymbolTable(table.uri)));
                case 1 /* Class */:
                case 2 /* Interface */:
                case 4 /* Trait */:
                case 64 /* Function */:
                case 8 /* Constant */:
                    return this.refStore.find(symbol.name);
                case 16 /* Property */:
                    return this._propertyReferences(symbol, table);
                case 1024 /* ClassConstant */:
                    return this._classConstantReferences(symbol, table);
                case 32 /* Method */:
                    return this._methodReferences(symbol, table);
                default:
                    return Promise.resolve([]);
            }
        };
    }
    provideReferenceLocations(uri, position, referenceContext) {
        let locations = [];
        let doc = this.documentStore.find(uri);
        let table = this.refStore.getReferenceTable(uri);
        if (!doc || !table) {
            return Promise.resolve(locations);
        }
        let symbols;
        let ref = table.referenceAtPosition(position);
        if (ref) {
            //get symbol definition
            //for constructors get the class instead of __construct
            if (ref.kind === 2048 /* Constructor */) {
                ref = { kind: 1 /* Class */, name: ref.name, location: ref.location };
            }
            //if class member then make sure base symbol is fetched
            symbols = this.symbolStore.findSymbolsByReference(ref, 3 /* Base */);
        }
        else {
            return Promise.resolve(locations);
        }
        return this.provideReferences(symbols, table, referenceContext.includeDeclaration).then((refs) => {
            return refs.map((v) => {
                return v.location;
            });
        });
    }
    /**
     *
     * @param symbols must be base symbols where kind is method, class const or prop
     * @param table
     * @param includeDeclaration
     */
    provideReferences(symbols, table, includeDeclaration) {
        let refs = [];
        let provideRefsFn = this._provideReferences;
        return new Promise((resolve, reject) => {
            let onResolve = (r) => {
                Array.prototype.push.apply(refs, r);
                let s = symbols.pop();
                if (s) {
                    provideRefsFn(s, table).then(onResolve);
                }
                else {
                    resolve(Array.from(new Set(refs)));
                }
            };
            onResolve([]);
        });
    }
    _methodReferences(symbol, table) {
        if ((symbol.modifiers & 4 /* Private */) > 0) {
            let lcScope = symbol.scope ? symbol.scope.toLowerCase() : '';
            let name = symbol.name.toLowerCase();
            let fn = (x) => {
                return x.kind === 32 /* Method */ && x.name.toLowerCase() === name && x.scope && x.scope.toLowerCase() === lcScope;
            };
            return Promise.resolve(this._symbolRefsInTableScope(symbol, table, fn));
        }
        else {
            return this.refStore.find(symbol.name, this._createMemberReferenceFilterFn(symbol));
        }
    }
    _classConstantReferences(symbol, table) {
        if ((symbol.modifiers & 4 /* Private */) > 0) {
            let lcScope = symbol.scope ? symbol.scope.toLowerCase() : '';
            let fn = (x) => {
                return x.kind === 1024 /* ClassConstant */ && x.name === symbol.name && x.scope && x.scope.toLowerCase() === lcScope;
            };
            return Promise.resolve(this._symbolRefsInTableScope(symbol, table, fn));
        }
        else {
            return this.refStore.find(symbol.name, this._createMemberReferenceFilterFn(symbol));
        }
    }
    _propertyReferences(symbol, table) {
        let name = symbol.name;
        if ((symbol.modifiers & 4 /* Private */) > 0) {
            let lcScope = symbol.scope ? symbol.scope.toLowerCase() : '';
            let fn = (x) => {
                return x.kind === 16 /* Property */ && x.name === name && x.scope && lcScope === x.scope.toLowerCase();
            };
            return Promise.resolve(this._symbolRefsInTableScope(symbol, table, fn));
        }
        else {
            return this.refStore.find(name, this._createMemberReferenceFilterFn(symbol));
        }
    }
    _createMemberReferenceFilterFn(baseMember) {
        let store = this.symbolStore;
        let lcBaseTypeName = baseMember.scope ? baseMember.scope.toLowerCase() : '';
        let map = {};
        map[lcBaseTypeName] = true;
        let associatedFilterFn = (x) => {
            return lcBaseTypeName === x.name.toLowerCase();
        };
        return (r) => {
            if (!(r.kind & (16 /* Property */ | 32 /* Method */ | 1024 /* ClassConstant */)) || !r.scope) {
                return false;
            }
            let lcScope = r.scope.toLowerCase();
            if (map[lcScope] !== undefined) {
                return map[lcScope];
            }
            let aggregateType = typeAggregate_1.TypeAggregate.create(store, r.scope);
            if (!aggregateType) {
                return map[lcScope] = false;
            }
            return map[lcScope] = aggregateType.associated(associatedFilterFn).length > 0;
        };
    }
    _variableReferences(symbol, refTable, symbolTable) {
        let symbolTreeTraverser = symbolTable.createTraverser();
        symbolTreeTraverser.find((x) => {
            return x === symbol;
        });
        let outerScope = symbolTreeTraverser.parent();
        let useVarFn = (s) => {
            return s.kind === 256 /* Variable */ &&
                (s.modifiers & 4096 /* Use */) > 0 &&
                s.name === symbol.name;
        };
        let isScopeSymbol = (x) => {
            return x.kind === 64 /* Function */ && (x.modifiers & 512 /* Anonymous */) > 0 && util.find(x.children, useVarFn) !== undefined;
        };
        while (outerScope && isScopeSymbol(outerScope)) {
            outerScope = symbolTreeTraverser.parent();
        }
        if (!outerScope) {
            return [];
        }
        //collect all scope positions to look for refs
        let scopePositions = [];
        let varScopeVisitor = {
            preorder: (node, spine) => {
                if (node === outerScope || isScopeSymbol(node)) {
                    if (node.location) {
                        scopePositions.push(node.location.range.start);
                    }
                    return true;
                }
                return false;
            }
        };
        symbolTreeTraverser.traverse(varScopeVisitor);
        if (!scopePositions.length) {
            return [];
        }
        let refTreeTraverser = refTable.createTraverser();
        let refs = [];
        let refFn = (r) => {
            return (r.kind === 256 /* Variable */ || r.kind === 128 /* Parameter */) && r.name === symbol.name;
        };
        let isScope = (x) => {
            return x.kind === undefined && x.location && scopePositions.length && util.positionEquality(x.location.range.start, scopePositions[0]);
        };
        if (!refTreeTraverser.find(isScope)) {
            return [];
        }
        let refVisitor = {
            preorder: (node, spine) => {
                if (isScope(node)) {
                    scopePositions.shift();
                    return true;
                }
                else if (refFn(node)) {
                    refs.push(node);
                }
                return false;
            }
        };
        refTreeTraverser.traverse(refVisitor);
        return refs;
    }
    _symbolRefsInTableScope(symbol, refTable, filterFn) {
        let traverser = refTable.createTraverser();
        let pos = symbol.location ? symbol.location.range.start : undefined;
        if (!pos) {
            return [];
        }
        let findFn = (x) => {
            return x.kind === undefined &&
                x.location && x.location.range && util.positionEquality(x.location.range.start, pos);
        };
        if (traverser.find(findFn) && traverser.parent()) {
            return traverser.filter(filterFn);
        }
        return [];
    }
}
exports.ReferenceProvider = ReferenceProvider;
