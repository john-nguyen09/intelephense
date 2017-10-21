/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import { Predicate, TreeVisitor, TreeTraverser, NameIndex, Traversable, SortedList } from './types';
import { SymbolIdentifier, SymbolKind } from './symbol';
import { Range, Location } from 'vscode-languageserver-types';
import * as util from './util';
import { FileCache, Cache } from './cache';
import { Log } from './logger';

export interface Reference extends SymbolIdentifier {
    location: Location;
    type?: string;
    altName?: string;
}

export namespace Reference {
    export function create(kind: SymbolKind, name: string, location: Location): Reference {
        return {
            kind: kind,
            name: name,
            location: location
        };
    }
}

export interface Scope {
    range: Range;
    children: (Scope | Range)[]
}

export class ReferenceTable implements Traversable<Scope | Reference> {

    private _uri: string;
    private _root: Scope;
    private _hash: number;

    constructor(uri: string, root: Scope) {
        this._uri = uri;
        this._root = root;
        this._hash = util.hash32(uri);
    }

    get uri() {
        return this._uri;
    }

    get root() {
        return this._root;
    }

    get hash() {
        return this._hash;
    }

    get referenceCount() {
        return this.references().length;
    }

    references(filter?: Predicate<Reference>) {
        let traverser = new TreeTraverser([this.root]);
        let visitor = new ReferencesVisitor(filter);
        traverser.traverse(visitor);
        return visitor.references;
    }

    referenceAtPosition(position: Position) {



    }

    traverse(visitor: TreeVisitor<Scope | Reference>) {
        let traverser = new TreeTraverser([this.root]);
        traverser.traverse(visitor);
        return visitor;
    }
}

interface ReferenceTableSummary {
    uri: string;
    identifiers: string[];
}

namespace ReferenceTableSummary {
    export function fromTable(table: ReferenceTable) {
        return (<ReferenceTableSummaryVisitor>table.traverse(new ReferenceTableSummaryVisitor(table.uri))).referenceTableSummary;
    }

    export function create(uri: string, identifiers: string[]) {
        return {
            uri: this.uri,
            identifiers: identifiers
        };
    }

    var collator = new Intl.Collator('en');
    export function compare(a: ReferenceTableSummary, b: ReferenceTableSummary) {
        return collator.compare(a.uri, b.uri);
    }

    export function keys(x: ReferenceTableSummary) {
        return x.identifiers;
    }

    export function uriCompareFn(uri: string) {
        return (x: ReferenceTableSummary) => {
            return collator.compare(x.uri, uri);
        }
    }

}

export class ReferenceStore {

    private _tables: ReferenceTable[];
    private _nameIndex: NameIndex<ReferenceTableSummary>;
    private _summaryIndex: SortedList<ReferenceTableSummary>;
    private _cache: Cache;

    constructor(cache: Cache) {
        this._nameIndex = new NameIndex<ReferenceTableSummary>(ReferenceTableSummary.keys);
        this._summaryIndex = new SortedList<ReferenceTableSummary>(ReferenceTableSummary.compare);
        this._tables = [];
        this._cache = cache;
    }

    getReferenceTable(uri: string) {
        return util.find<ReferenceTable>(this._tables, (t) => { return t.uri === uri; });
    }

    add(table: ReferenceTable) {
        if (this.getReferenceTable(table.uri)) {
            this.remove(table.uri);
        }
        this._tables.push(table);
        let summary = ReferenceTableSummary.fromTable(table);
        this._summaryIndex.add(summary);
        this._nameIndex.add(summary);
    }

    remove(uri: string, purge?: boolean) {
        this._tablesRemove(uri);
        let summary = this._summaryRemove(uri);
        if (!summary) {
            return;
        }
        this._nameIndex.remove(summary);
        if (purge) {
            this._cache.delete(uri);
        }
    }

    close(uri: string) {
        let table = this._tablesRemove(uri);
        if (table) {
            this._cache.write(table.uri, table);
        }
    }

    closeAll() {
        let tables = this._tables;
        let cache = this._cache;
        this._tables = [];

        let writeTableFn = () => {
            let table = tables.pop();
            if (!table) {
                return;
            }
            cache.write(table.uri, table).then(writeTableFn).catch(Log.warn);
        }

        let maxOpenFiles = Math.min(8, tables.length);
        for (let n = 0; n < maxOpenFiles; ++n) {
            writeTableFn();
        }

    }

    find(name: string, filter?: Predicate<Reference>): Promise<Reference[]> {

        if (!name) {
            return Promise.resolve<Reference[]>([]);
        }

        //find uris that contain ref matching name
        let summaries = this._nameIndex.find(name);
        let count = summaries.length;
        if(!count) {
            return Promise.resolve<Reference[]>([]);
        }
        let tables: ReferenceTable[] = [];
        let fetchTableFn = this._fetchTable;
        let findInTablesFn = this._findInTables;

        return new Promise<Reference[]>((resolve, reject) => {

            let onSuccess = (table:ReferenceTable) => {
                tables.push(table);
                onAlways();
            }

            let onFail = (msg:string) => {
                Log.warn(msg);
                onAlways();
            }

            let onAlways = () => {
                count--;
                if(count < 1) {
                    resolve(findInTablesFn(tables, name, filter));
                } else {
                    let summary = summaries.pop();
                    if(summary) {
                        fetchTableFn(summary.uri).then(onSuccess).catch(onFail);
                    }
                }
            }

            let maxOpenFiles = Math.min(8, summaries.length);
            while(maxOpenFiles--) {
                fetchTableFn(summaries.pop().uri).then(onSuccess).catch(onFail);
            }

        });

    }

    private _findInTables(tables:ReferenceTable[], name:string, filter?:Predicate<Reference>) {

        const caseSensitiveKindMask = SymbolKind.Property | SymbolKind.Variable | SymbolKind.Constant | SymbolKind.ClassConstant;
        let refs:Reference[] = [];
        let lcName = name.toLowerCase();
        let table:ReferenceTable;

        if(!name || !tables.length) {
            return refs;
        }

        let predicate = (r:Reference) => {
            return (((r.kind & caseSensitiveKindMask) > 0 && name === r.name) || 
                (!(r.kind & caseSensitiveKindMask) && lcName === r.name.toLowerCase())) &&
                (!filter || filter(r));
        }

        for(let n = 0; n < tables.length; ++n) {
            table = tables[n];
            Array.prototype.push.apply(refs, table.references(predicate));
        }

        return refs;

    }

    private _fetchTable = (uri:string) => {
        let findOpenTableFn = (t) => { return t.uri === uri };
        let table = this.getReferenceTable(uri);

        if (table) {
            return Promise.resolve<ReferenceTable>(table);
        } else {
            return this._cache.read(uri).then((obj) => {
                return Promise.resolve<ReferenceTable>(new ReferenceTable(uri, obj));
            });
        }
    }

    private _tablesRemove(uri: string) {
        let index = this._tables.findIndex((t) => { return t.uri === uri; });
        if (index > -1) {
            return this._tables.splice(index, 1).shift();
        }
        return undefined;
    }

    private _summaryRemove(uri: string) {
        let cmpFn = ReferenceTableSummary.uriCompareFn(uri);
        return this._summaryIndex.remove(cmpFn);
    }

}

class ReferencesVisitor implements TreeVisitor<Scope | Reference> {

    private _filter: Predicate<Reference>;
    private _refs: Reference[];

    constructor(filter?: Predicate<Reference>) {
        this._filter = filter;
        this._refs = [];
    }

    get references() {
        return this._refs;
    }

    preorder(node: Scope | Reference, spine: (Scope | Reference)[]) {

        if ((<Reference>node).kind !== undefined && (!this._filter || this._filter(<Reference>node))) {
            this._refs.push(<Reference>node);
        }

        return true;

    }

}

class ReferenceTableSummaryVisitor implements TreeVisitor<Scope | Reference> {

    private identifiers: Set<string>;

    constructor(private uri: string) {
        this.identifiers = new Set<string>();
    }

    get referenceTableSummary(): ReferenceTableSummary {
        return ReferenceTableSummary.create(this.uri, Array.from(this.identifiers));
    }

    preorder(node: Scope | Reference, spine: (Scope | Reference)[]) {
        if (this._shouldIndex(node)) {
            let lcName = (<Reference>node).name.toLowerCase();
            let altName = (<Reference>node).altName;
            if (lcName) {
                this.identifiers.add(lcName);
            }
            if (altName) {
                let lcAltName = altName.toLowerCase();
                if (lcAltName !== lcName && lcAltName !== 'static' && lcAltName !== 'self' && lcAltName !== 'parent') {
                    this.identifiers.add(lcAltName);
                }
            }
        }
        return true;
    }

    private _shouldIndex(node: Scope | Reference) {
        switch ((<Reference>node).kind) {
            case undefined:
            case SymbolKind.Variable:
            case SymbolKind.Parameter:
                return false;
            default:
                return true;
        }
    }

}