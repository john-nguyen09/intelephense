/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import { Range } from 'vscode-languageserver-types';
import * as fuzzysearch from 'fuzzysearch';

export interface Predicate<T> {
    (t: T): boolean;
}

export interface DebugLogger {
    debug(message: string): void;
}

export interface EventHandler<T> {
    (t: T): void;
}

export interface Unsubscribe {
    (): void;
}

export class Event<T> {

    private _subscribed: EventHandler<T>[];

    constructor() {
        this._subscribed = [];
    }

    subscribe(handler: EventHandler<T>): Unsubscribe {
        this._subscribed.push(handler);
        let index = this._subscribed.length - 1;
        let subscribed = this._subscribed;
        return () => {
            subscribed.splice(index, 1);
        };
    }

    trigger(args: T) {
        let handler: EventHandler<T>;
        for (let n = 0; n < this._subscribed.length; ++n) {
            handler = this._subscribed[n];
            handler(args);
        }
    }

}

export interface HashedLocation {
    uri: string;
    range: Range;
}

export namespace HashedLocation {
    export function create(uri: string, range: Range) {
        return <HashedLocation>{
            uri: uri,
            range: range
        };
    }
}

export interface TreeLike {
    [index: string]: any,
    children?: TreeLike[]
}

export class TreeTraverser<T extends TreeLike> {

    protected _spine: T[];

    constructor(spine: T[]) {
        this._spine = spine.slice(0);
    }

    get spine() {
        return this._spine.slice(0);
    }

    get node() {
        return this._spine.length ? this._spine[this._spine.length - 1] : null;
    }

    traverse(visitor: TreeVisitor<T>) {
        this._traverse(this.node, visitor, this._spine.slice(0));
    }

    filter(predicate: Predicate<T>) {

        let visitor = new FilterVisitor<T>(predicate);
        this.traverse(visitor);
        return visitor.array;

    }

    toArray() {
        let visitor = new ToArrayVisitor<T>();
        this.traverse(visitor);
        return visitor.array;
    }

    count() {
        let visitor = new CountVisitor<T>();
        this.traverse(visitor);
        return visitor.count;
    }

    depth() {
        return this._spine.length - 1;
    }

    up(n: number) {
        let steps = Math.max(this._spine.length - 1, n);
        this._spine = this._spine.slice(0, this._spine.length - steps);
    }

    find(predicate: Predicate<T>) {

        let visitor = new FindVisitor<T>(predicate);
        this.traverse(visitor);

        if (visitor.found) {
            this._spine = visitor.found;
            return this.node;
        }

        return null;

    }

    child(predicate: Predicate<T>) {

        let parent = this.node;
        if (!parent || !parent.children) {
            return null;
        }

        for (let n = 0; n < parent.children.length; ++n) {
            if (predicate(<T>parent.children[n])) {
                this._spine.push(<T>parent.children[n]);
                return this.node;
            }
        }

        return null;
    }

    nthChild(n: number) {
        let parent = this.node;
        if (!parent || !parent.children || n < 0 || n > parent.children.length - 1) {
            return undefined;
        }

        this._spine.push(<T>parent.children[n]);
        return this.node;
    }

    childCount() {
        let node = this.node;
        return node && node.children ? node.children.length : 0;
    }

    prevSibling() {

        if (this._spine.length < 2) {
            return null;
        }

        let parent = this._spine[this._spine.length - 2];
        let childIndex = parent.children.indexOf(this.node);

        if (childIndex > 0) {
            this._spine.pop();
            this._spine.push(<T>parent.children[childIndex - 1]);
            return this.node;
        } else {
            return null;
        }

    }

    nextSibling() {

        if (this._spine.length < 2) {
            return null;
        }

        let parent = this._spine[this._spine.length - 2];
        let childIndex = parent.children.indexOf(this.node);

        if (childIndex < parent.children.length - 1) {
            this._spine.pop();
            this._spine.push(<T>parent.children[childIndex + 1]);
            return this.node;
        } else {
            return null;
        }

    }

    ancestor(predicate: Predicate<T>) {

        for (let n = this._spine.length - 2; n >= 0; --n) {
            if (predicate(this._spine[n])) {
                this._spine = this._spine.slice(0, n + 1);
                return this.node;
            }
        }

        return undefined;

    }

    parent() {
        if (this._spine.length > 1) {
            this._spine.pop();
            return this.node;
        }

        return null;
    }

    clone() {
        return new TreeTraverser(this._spine);
    }

    private _traverse(treeNode: T, visitor: TreeVisitor<T>, spine: T[]) {

        if (visitor.haltTraverse) {
            return;
        }

        let descend = true;

        if (visitor.preorder) {
            descend = visitor.preorder(treeNode, spine);
            if (visitor.haltTraverse) {
                return;
            }
        }

        if (treeNode.children && descend) {

            spine.push(treeNode);
            for (let n = 0, l = treeNode.children.length; n < l; ++n) {
                this._traverse(<T>treeNode.children[n], visitor, spine);
                if (visitor.haltTraverse) {
                    return;
                }
            }
            spine.pop();

        }

        if (visitor.postorder) {
            visitor.postorder(treeNode, spine);
        }

    }

}

export interface Traversable<T extends TreeLike> {
    traverse(visitor: TreeVisitor<T>): TreeVisitor<T>;
}

export interface TreeVisitor<T extends TreeLike> {

    /**
     * True will halt traverse immediately.
     * No further functions will be called.
     */
    haltTraverse?: boolean;

    /**
     * Return value determines whether to descend into child nodes
     */
    preorder?(node: T, spine: T[]): boolean;

    postorder?(node: T, spine: T[]): void;

}

class FilterVisitor<T> implements TreeVisitor<T>{

    private _predicate: Predicate<T>;
    private _array: T[];

    constructor(predicate: Predicate<T>) {
        this._predicate = predicate;
        this._array = [];
    }

    get array() {
        return this._array;
    }

    preorder(node: T, spine: T[]) {
        if (this._predicate(node)) {
            this._array.push(node);
        }
        return true;
    }

}

class FindVisitor<T> implements TreeVisitor<T> {

    private _predicate: Predicate<T>;
    private _found: T[];

    haltTraverse: boolean;

    constructor(predicate: Predicate<T>) {
        this._predicate = predicate;
        this.haltTraverse = false;
    }

    get found() {
        return this._found;
    }

    preorder(node: T, spine: T[]) {

        if (this._predicate(node)) {
            this._found = spine.slice(0);
            this._found.push(node);
            this.haltTraverse = true;
            return false;
        }

        return true;
    }

}

export class Debounce<T> {

    private _handler: (e: T) => void;
    private _lastEvent: T;
    private _timer: number | NodeJS.Timer;

    constructor(handler: (e: T) => void, public wait: number) {
        this._handler = handler;
        this.wait = wait;
    }

    clear = () => {
        clearTimeout(<any>this._timer);
        this._timer = null;
        this._lastEvent = null;
    }

    handle(event: T) {
        this.clear();
        this._lastEvent = event;
        let that = this;
        let handler = this._handler;
        let clear = this.clear;
        let later = () => {
            handler.apply(that, [event]);
            clear();
        };
        this._timer = setTimeout(later, this.wait);
    }

    flush() {
        if (!this._timer) {
            return;
        }

        let event = this._lastEvent;
        this.clear();
        this._handler.apply(this, [event]);

    }

}


export class ToArrayVisitor<T> implements TreeVisitor<T> {

    private _array: T[];

    constructor() {
        this._array = [];
    }

    get array() {
        return this._array;
    }

    preorder(t: T, spine: T[]) {
        this._array.push(t);
        return true;
    }

}

export class CountVisitor<T> implements TreeVisitor<T> {

    private _count: number

    constructor() {
        this._count = 0;
    }

    get count() {
        return this._count;
    }

    preorder(t: T, spine: T[]) {
        ++this._count;
        return true;
    }
}


export class MultiVisitor<T> implements TreeVisitor<T> {

    protected _visitors: [TreeVisitor<T>, TreeLike][];

    haltTraverse = false;

    constructor(visitors: TreeVisitor<T>[]) {
        this._visitors = [];
        for (let n = 0; n < visitors.length; ++n) {
            this.add(visitors[n]);
        }
    }

    add(v: TreeVisitor<T>) {
        this._visitors.push([v, null]);
    }

    preorder(node: T, spine: T[]) {
        let v: [TreeVisitor<T>, TreeLike];
        let descend: boolean;
        for (let n = 0; n < this._visitors.length; ++n) {
            v = this._visitors[n];
            if (!v[1] && v[0].preorder && !v[0].preorder(node, spine)) {
                v[1] = node;
            }
            if (v[0].haltTraverse) {
                this.haltTraverse = true;
                break;
            }
        }
        return true;
    }

    postorder(node: T, spine: T[]) {
        let v: [TreeVisitor<T>, TreeLike];
        for (let n = 0; n < this._visitors.length; ++n) {
            v = this._visitors[n];
            if (v[1] === node) {
                v[1] = null;
            }
            if (!v[1] && v[0].postorder) {
                v[0].postorder(node, spine);
            }
            if (v[0].haltTraverse) {
                this.haltTraverse = true;
                break;
            }
        }
    }

}


export class BinarySearch<T> {

    private _sortedArray: T[];

    constructor(sortedArray: T[]) {
        this._sortedArray = sortedArray;
    }

    find(compare: (n: T) => number) {
        let result = this.search(compare);
        return result.isExactMatch ? this._sortedArray[result.rank] : null;
    }

    rank(compare: (n: T) => number) {
        return this.search(compare).rank;
    }

    range(compareLower: (n: T) => number, compareUpper: (T) => number) {
        let rankLower = this.rank(compareLower);
        return this._sortedArray.slice(rankLower, this.search(compareUpper, rankLower).rank);
    }

    search(compare: (n: T) => number, offset?: number): BinarySearchResult {

        let left = offset ? offset : 0;
        let right = this._sortedArray.length - 1;
        let mid = 0;
        let compareResult = 0;
        let searchResult: BinarySearchResult;

        while (true) {

            if (left > right) {
                searchResult = { rank: left, isExactMatch: false };
                break;
            }

            mid = Math.floor((left + right) / 2);
            compareResult = compare(this._sortedArray[mid]);

            if (compareResult < 0) {
                left = mid + 1;
            } else if (compareResult > 0) {
                right = mid - 1;
            } else {
                searchResult = { rank: mid, isExactMatch: true };
                break;
            }

        }

        return searchResult;

    }

}

export interface BinarySearchResult {
    rank: number;
    isExactMatch: boolean
}

export interface NameIndexNode<T> {
    key: string;
    items: T[];
}

export type KeysDelegate<T> = (t: T) => string[];

export class NameIndex<T> {

    private _keysDelegate: KeysDelegate<T>;
    private _nameIndex: Map<string, T[]>;

    constructor(keysDelegate: KeysDelegate<T>) {
        this._nameIndex = new Map<string, T[]>();
        this._keysDelegate = keysDelegate;
    }

    add(item: T) {
        let suffixes = this._keysDelegate(item);

        for (let n = 0; n < suffixes.length; ++n) {
            if (!this._nameIndex.has(suffixes[n])) {
                this._nameIndex.set(suffixes[n], [item]);
            } else {
                this._nameIndex.get(suffixes[n]).push(item);
            }

        }
    }

    addMany(items: T[]) {
        for (let n = 0; n < items.length; ++n) {
            this.add(items[n]);
        }
    }

    remove(item: T) {
        let suffixes = this._keysDelegate(item);

        for (let n = 0; n < suffixes.length; ++n) {
            let items = this._nameIndex.get(suffixes[n]);
            let index = items.indexOf(item);

            items.splice(index, 1);
        }
    }

    removeMany(items: T[]) {
        for (let n = 0; n < items.length; ++n) {
            this.remove(items[n]);
        }
    }

    removeFromKey(key: string) {
        this._nameIndex.delete(key);
    }

    /**
     * Matches all items that contain (fuzzy) text
     * @param text 
     */
    match(text: string) {
        let matches = new Set<T>();

        for (let key of this._nameIndex.keys()) {
            if (fuzzysearch(text, key)) {
                Set.prototype.add.apply(matches, this._nameIndex.get(key));
            }
        }

        return Array.from(matches);
    }

    /**
     * Finds all items that match (case insensitive) text exactly
     * @param text 
     */
    find(text: string) {
        let results = this._nameIndex.get(text);

        if (!results) {
            return [];
        }

        return results;
    }

    filter(filter: Predicate<T>) {
        let matches: T[] = [];

        for (let entry of this._nameIndex.entries()) {
            for (let item of entry[1]) {
                if (filter(item)) {
                    matches.push(item);
                }
            }
        }

        return matches;
    }

    toJSON() {
        return this._nameIndex;
    }

    fromJSON(data: Map<string, T[]>) {
        this._nameIndex = data;
    }
}

export type Comparer<T> = (a: T, b: T) => number;

export class SortedList<T> {

    protected _items: T[];
    protected _search: BinarySearch<T>;

    constructor(protected compareFn: Comparer<T>, items?:T[]) {
        this._items = items || [];
        this._search = new BinarySearch<T>(this._items);
    }

    get length() {
        return this._items.length;
    }

    get items() {
        return this._items;
    }

    add(item: T) {
        let cmpFn = this._createCompareClosure(item, this.compareFn);
        let result = this._search.search(cmpFn);
        if(result.isExactMatch) {
            throw new Error(`Duplicate key ${JSON.stringify(item)}`);
        }
        this._items.splice(result.rank, 0, item);
    }

    remove(compareFn: (t: T) => number) {
        let result = this._search.search(compareFn);
        if(result.isExactMatch) {
            return this._items.splice(result.rank, 1).shift();
        }
        return undefined;
    }

    find(compareFn: (t: T) => number) {
        return this._search.find(compareFn);
    }

    private _createCompareClosure(item: T, cmpFn: (a: T, b: T) => number) {
        return (t: T): number => {
            return cmpFn(t, item);
        }
    }

}
